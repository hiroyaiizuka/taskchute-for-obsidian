import {
  findNodeInKnownLocations,
  findNodeOnPath,
  listNodeExecutableCandidates,
  type NodeExecutableProbe,
} from '@/features/ai-task/services/NodeExecutableLocator'

/**
 * Obsidian launched from the Dock inherits launchd's PATH, which has no node
 * on a stock Mac. The broker used to be spawned by bare name there, so a +
 * terminal opened before any AI task ran could never start.
 */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const HOME = '/Users/someone'

function probeWith(
  executables: readonly string[],
  directories: Record<string, string[]> = {},
): NodeExecutableProbe {
  return {
    isExecutableFile: (path) => executables.includes(path),
    listDirectory: (path) => directories[path] ?? [],
  }
}

describe('findNodeOnPath', () => {
  test('returns the first absolute directory holding node', () => {
    const probe = probeWith(['/b/node', '/c/node'])

    expect(findNodeOnPath('/a:/b:/c', probe)).toBe('/b/node')
  })

  test('ignores empty and relative entries', () => {
    const probe = probeWith(['node', './node', '/c/node'])

    expect(findNodeOnPath(':.:bin:/c', probe)).toBe('/c/node')
  })

  test('finds nothing on the launchd PATH of a Dock-launched app', () => {
    expect(findNodeOnPath(LAUNCHD_PATH, probeWith(['/opt/homebrew/bin/node']))).toBeUndefined()
  })
})

describe('findNodeInKnownLocations', () => {
  test('tries Homebrew, then /usr/local, then the system directory', () => {
    const probe = probeWith(['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'])

    expect(findNodeInKnownLocations({ HOME }, probe)).toEqual([
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
    ])
  })

  test('prefers the newest nvm install and ignores non-version entries', () => {
    const root = `${HOME}/.nvm/versions/node`
    const probe = probeWith(
      [`${root}/v18.20.4/bin/node`, `${root}/v22.3.0/bin/node`, `${root}/v20.11.1/bin/node`],
      { [root]: ['v18.20.4', 'v22.3.0', '.DS_Store', 'v20.11.1'] },
    )

    expect(findNodeInKnownLocations({ HOME }, probe)).toEqual([
      `${root}/v22.3.0/bin/node`,
      `${root}/v20.11.1/bin/node`,
      `${root}/v18.20.4/bin/node`,
    ])
  })

  test('puts real binaries before version-manager shims', () => {
    const probe = probeWith([
      `${HOME}/.nodenv/shims/node`,
      `${HOME}/.local/share/mise/shims/node`,
      `${HOME}/.volta/bin/node`,
      '/usr/local/bin/node',
    ])

    expect(findNodeInKnownLocations({ HOME }, probe)).toEqual([
      '/usr/local/bin/node',
      `${HOME}/.volta/bin/node`,
      `${HOME}/.local/share/mise/shims/node`,
      `${HOME}/.nodenv/shims/node`,
    ])
  })

  // The same overrides BinaryLocator honours for the AI CLIs.
  test('honours NVM_DIR, VOLTA_HOME, MISE_DATA_DIR, ASDF_DATA_DIR and NODENV_ROOT before HOME', () => {
    const env = {
      HOME,
      NVM_DIR: '/opt/nvm',
      VOLTA_HOME: '/opt/volta/',
      MISE_DATA_DIR: '/data/mise',
      ASDF_DATA_DIR: '/data/asdf',
      NODENV_ROOT: '/data/nodenv',
    }
    const probe = probeWith(
      [
        '/opt/nvm/versions/node/v20.0.0/bin/node',
        '/opt/volta/bin/node',
        `${HOME}/.volta/bin/node`,
        '/data/mise/shims/node',
        '/data/asdf/shims/node',
        '/data/nodenv/shims/node',
      ],
      { '/opt/nvm/versions/node': ['v20.0.0'] },
    )

    expect(findNodeInKnownLocations(env, probe)).toEqual([
      '/opt/volta/bin/node',
      `${HOME}/.volta/bin/node`,
      '/opt/nvm/versions/node/v20.0.0/bin/node',
      '/data/mise/shims/node',
      '/data/nodenv/shims/node',
      '/data/asdf/shims/node',
    ])
  })

  test('skips the home directory when it is unknown or relative', () => {
    const probe = probeWith(['relative/.volta/bin/node', '/usr/local/bin/node'])

    expect(findNodeInKnownLocations({}, probe)).toEqual(['/usr/local/bin/node'])
    expect(findNodeInKnownLocations({ HOME: 'relative' }, probe)).toEqual(['/usr/local/bin/node'])
  })
})

describe('listNodeExecutableCandidates', () => {
  test('a Dock-launched app still finds Homebrew node', () => {
    expect(
      listNodeExecutableCandidates(
        'darwin',
        { PATH: LAUNCHD_PATH, HOME },
        probeWith(['/opt/homebrew/bin/node']),
      ),
    ).toEqual(['/opt/homebrew/bin/node'])
  })

  test('the PATH comes first and duplicates are dropped', () => {
    expect(
      listNodeExecutableCandidates(
        'darwin',
        { PATH: `${HOME}/.volta/bin:/opt/homebrew/bin`, HOME },
        probeWith(['/opt/homebrew/bin/node', `${HOME}/.volta/bin/node`]),
      ),
    ).toEqual([`${HOME}/.volta/bin/node`, '/opt/homebrew/bin/node'])
  })

  test('is empty when no Node.js exists anywhere', () => {
    expect(
      listNodeExecutableCandidates('linux', { PATH: LAUNCHD_PATH, HOME }, probeWith([])),
    ).toEqual([])
  })

  test('keeps the bare name on Windows', () => {
    expect(listNodeExecutableCandidates('win32', {}, probeWith([]))).toEqual(['node'])
  })
})
