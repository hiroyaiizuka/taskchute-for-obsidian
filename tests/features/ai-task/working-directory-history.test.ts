import {
  MAX_WORKING_DIRECTORY_HISTORY,
  WORKING_DIRECTORY_HISTORY_STORAGE_KEY,
  WorkingDirectoryHistory,
  buildWorkingDirectoryChoices,
  normalizeDirectoryPath,
  normalizeDirectoryPathForComparison,
} from '../../../src/features/ai-task/services/WorkingDirectoryHistory'

describe('WorkingDirectoryHistory', () => {
  test.each([
    ['  /Users/me/project///  ', '/Users/me/project'],
    ['C:\\Users\\Me\\Project\\', 'C:/Users/Me/Project'],
    ['C:\\', 'C:/'],
    ['\\\\server\\share\\folder\\', '//server/share/folder'],
    ['\\\\server\\share\\', '//server/share'],
    ['/', '/'],
    ['   ', ''],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeDirectoryPath(input)).toBe(expected)
  })

  test('compares Windows drive and UNC paths case-insensitively but keeps POSIX case', () => {
    expect(normalizeDirectoryPathForComparison('C:\\Repo\\Src')).toBe('c:/repo/src')
    expect(normalizeDirectoryPathForComparison('\\\\SERVER\\Share\\Dir')).toBe(
      '//server/share/dir',
    )
    expect(normalizeDirectoryPathForComparison('/Repo/Src')).toBe('/Repo/Src')
  })

  test('merges stored history before task candidates, removes duplicates/default, and caps the result', () => {
    const choices = buildWorkingDirectoryChoices({
      defaultDirectory: 'C:\\Repo\\',
      storedDirectories: [
        'C:/Recent',
        'c:\\recent\\',
        'C:/Repo',
        ...Array.from({ length: 12 }, (_value, index) => `/stored/${index}`),
      ],
      candidateDirectories: ['C:/Candidate', '/stored/0'],
    })

    expect(choices.defaultDirectory).toBe('C:/Repo')
    expect(choices.recentDirectories).toHaveLength(MAX_WORKING_DIRECTORY_HISTORY)
    expect(choices.recentDirectories.slice(0, 3)).toEqual([
      'C:/Recent',
      '/stored/0',
      '/stored/1',
    ])
    expect(choices.recentDirectories).not.toContain('C:/Repo')
    expect(choices.recentDirectories).not.toContain('C:/Candidate')
  })

  test('uses a device-local bridge, filters malformed stored values, and persists MRU order', () => {
    const loadLocalStorage = jest.fn(() => [
      '/old',
      7,
      null,
      'C:\\Repo\\',
      'c:/repo',
    ])
    const saveLocalStorage = jest.fn()
    const history = new WorkingDirectoryHistory({
      loadLocalStorage,
      saveLocalStorage,
    })

    expect(history.getChoices(['/candidate'], '/default')).toEqual({
      defaultDirectory: '/default',
      recentDirectories: ['/old', 'C:/Repo', '/candidate'],
    })
    expect(loadLocalStorage).toHaveBeenCalledWith(
      WORKING_DIRECTORY_HISTORY_STORAGE_KEY,
    )

    expect(history.add('/new/')).toEqual(['/new', '/old', 'C:/Repo'])
    expect(history.add('/old')).toEqual(['/old', '/new', 'C:/Repo'])
    expect(saveLocalStorage).toHaveBeenLastCalledWith(
      WORKING_DIRECTORY_HISTORY_STORAGE_KEY,
      ['/old', '/new', 'C:/Repo'],
    )
  })

  test('does not store an empty or default directory and tolerates an unavailable bridge', () => {
    const saveLocalStorage = jest.fn(() => {
      throw new Error('storage unavailable')
    })
    const history = new WorkingDirectoryHistory({
      loadLocalStorage: () => {
        throw new Error('storage unavailable')
      },
      saveLocalStorage,
    })

    expect(history.add('   ')).toEqual([])
    expect(history.add('C:\\repo\\', 'c:/REPO')).toEqual([])
    expect(history.add('/safe')).toEqual(['/safe'])
    expect(() => history.add('/still-safe')).not.toThrow()
  })

  test('keeps only the latest ten stored directories', () => {
    const saveLocalStorage = jest.fn()
    const history = new WorkingDirectoryHistory({
      loadLocalStorage: () => [],
      saveLocalStorage,
    })

    for (let index = 0; index < 12; index += 1) {
      history.add(`/repo/${index}`)
    }

    expect(history.getStoredDirectories()).toEqual(
      Array.from({ length: 10 }, (_value, index) => `/repo/${11 - index}`),
    )
  })
})
