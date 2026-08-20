/* eslint-disable camelcase */
jest.mock('../../lib/configManager', () =>
  jest.fn().mockImplementation(() => ({
    loadGlobalSettingsYaml: jest.fn(() => Promise.resolve({}))
  }))
)

const plugin = require('../../index')

const CHECK_NAME = 'Safe-setting validator'

function fakeRobot () {
  const handlers = new Map()
  return {
    handlers,
    log: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
    onError: jest.fn(),
    // info() runs unawaited at load time and calls robot.auth().
    auth: () => Promise.resolve(withRestNamespace({
      paginate: () => Promise.resolve([]),
      apps: { listInstallations: { endpoint: { merge: () => ({}) } } }
    })),
    on (events, fn) {
      for (const event of [].concat(events)) {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(fn)
      }
    },
    emit (event, context) {
      return Promise.all((handlers.get(event) || []).map((fn) => fn(context)))
    }
  }
}

function fakeSettings () {
  return {
    FILE_PATH: '.github/settings.yml',
    REPO_PATTERN: { test: (s) => /^\.github\/repos\/.+\.yml$/.test(s) },
    SUB_ORG_PATTERN: { test: (s) => /^\.github\/suborgs\/.+\.yml$/.test(s) },
    syncSelectedRepos: jest.fn(() => Promise.resolve()),
    syncAll: jest.fn(() => Promise.resolve())
  }
}

// Octokit exposes the REST methods under `rest`, which is what the app calls.
// Pointing `rest` back at the mock itself keeps one set of jest.fn() instances,
// so assertions can read either name and see the same calls.
function withRestNamespace (octokit) {
  octokit.rest = octokit
  return octokit
}

function fakeOctokit (filenames) {
  return withRestNamespace({
    paginate: jest.fn(() => Promise.resolve(filenames.map((filename) => ({ filename })))),
    pulls: { listFiles: { endpointMarker: 'listFiles' } },
    checks: {
      create: jest.fn(() => Promise.resolve({ data: { id: 1 } })),
      update: jest.fn(() => Promise.resolve({}))
    },
    repos: {
      getContent: jest.fn(() => Promise.resolve({ data: { content: '' } }))
    }
  })
}

function checkRunContext (octokit, files) {
  return {
    octokit,
    repo: (extra) => ({ owner: 'Lundalogik', repo: 'admin', ...extra }),
    payload: {
      repository: { name: 'admin', owner: { login: 'Lundalogik' } },
      check_run: {
        id: 99,
        name: CHECK_NAME,
        status: 'queued',
        check_suite: { pull_requests: [{ number: 7, head: { ref: 'topic' } }] }
      }
    }
  }
}

describe('check_suite.rerequested', () => {
  it('is registered exactly once', () => {
    const robot = fakeRobot()
    plugin(robot, {}, fakeSettings())
    expect(robot.handlers.get('check_suite.rerequested')).toHaveLength(1)
  })

  it('creates the check run against the check suite head sha', async () => {
    const robot = fakeRobot()
    plugin(robot, {}, fakeSettings())
    const octokit = fakeOctokit([])

    await robot.emit('check_suite.rerequested', {
      octokit,
      repo: (extra) => ({ owner: 'Lundalogik', repo: 'admin', ...extra }),
      payload: {
        repository: { name: 'admin', owner: { login: 'Lundalogik' } },
        check_suite: { head_sha: 'abc123' }
      }
    })

    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1)
    const params = octokit.rest.checks.create.mock.calls[0][0]
    expect(params.name).toBe(CHECK_NAME)
    expect(params.head_sha).toBe('abc123')
  })
})

describe('check_run.created', () => {
  it('paginates the changed files rather than reading one page', async () => {
    const robot = fakeRobot()
    const settings = fakeSettings()
    plugin(robot, {}, settings)

    const files = Array.from({ length: 40 }, (_, i) => `docs/file-${i}.md`)
    files.push('.github/repos/late-config.yml')
    const octokit = fakeOctokit(files)

    await robot.emit('check_run.created', checkRunContext(octokit, files))

    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.pulls.listFiles,
      expect.objectContaining({ pull_number: 7 })
    )
    expect(settings.syncSelectedRepos).toHaveBeenCalledTimes(1)
    const repos = settings.syncSelectedRepos.mock.calls[0][2]
    expect(repos).toEqual([{ owner: 'Lundalogik', repo: 'late-config' }])
  })

  it('reports no changes when only unrelated files changed', async () => {
    const robot = fakeRobot()
    const settings = fakeSettings()
    plugin(robot, {}, settings)

    const files = ['README.md']
    const octokit = fakeOctokit(files)

    await robot.emit('check_run.created', checkRunContext(octokit, files))

    expect(settings.syncSelectedRepos).not.toHaveBeenCalled()
    const completion = octokit.rest.checks.update.mock.calls.at(-1)[0]
    expect(completion.status).toBe('completed')
    expect(completion.conclusion).toBe('success')
  })
})
