import {
  AI_APPROVED_FOLDERS_STORAGE_KEY,
  AI_TRUSTED_FOLDERS_STORAGE_KEY,
  approveFolderOnThisDevice,
  displayFolder,
  displayName,
  folderConsentNeeded,
  folderKey,
  isFolderApprovedOnThisDevice,
  resolveTaskFolder,
  type FolderConsentStorage,
} from '@/features/ai-task/services/AiFolderConsent'
import { WORKING_DIRECTORY_HISTORY_STORAGE_KEY } from '@/features/ai-task/services/WorkingDirectoryHistory'

// LEV-390: the working folders this device lets AI tasks run in. A note's
// folder and its "trust this folder" are requests; this device decides.

function memoryStorage(
  initial: Record<string, unknown> = {},
): FolderConsentStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(initial))
  return {
    values,
    loadLocalStorage: (key) => values.get(key) ?? null,
    saveLocalStorage: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
    },
  }
}

describe('AiFolderConsent', () => {
  test('the recent-folders history is not an approval', () => {
    // A synced note's folder can land in the history just by being listed.
    const storage = memoryStorage({
      [WORKING_DIRECTORY_HISTORY_STORAGE_KEY]: ['/Users/me/Projects/app'],
    })
    expect(isFolderApprovedOnThisDevice(storage, '/Users/me/Projects/app', false)).toBe(false)
  })

  test('approving keeps the folder on this device, once', () => {
    const storage = memoryStorage()
    approveFolderOnThisDevice(storage, '/srv/work/', false)
    approveFolderOnThisDevice(storage, '/srv/work', false)
    expect(storage.values.get(AI_APPROVED_FOLDERS_STORAGE_KEY)).toEqual(['/srv/work'])
    expect(storage.values.has(AI_TRUSTED_FOLDERS_STORAGE_KEY)).toBe(false)
    expect(isFolderApprovedOnThisDevice(storage, '/srv/work', false)).toBe(true)
  })

  test('running in a folder does not trust it; trusting it does both', () => {
    const storage = memoryStorage()
    approveFolderOnThisDevice(storage, '/srv/work', false)
    expect(isFolderApprovedOnThisDevice(storage, '/srv/work', true)).toBe(false)

    approveFolderOnThisDevice(storage, '/srv/repo', true)
    expect(isFolderApprovedOnThisDevice(storage, '/srv/repo', true)).toBe(true)
    expect(isFolderApprovedOnThisDevice(storage, '/srv/repo', false)).toBe(true)
  })

  test('POSIX folders compare exactly', () => {
    const storage = memoryStorage({ [AI_APPROVED_FOLDERS_STORAGE_KEY]: ['/srv/site'] })
    expect(isFolderApprovedOnThisDevice(storage, '/srv/site/', false)).toBe(true)
    expect(isFolderApprovedOnThisDevice(storage, '/srv/./site', false)).toBe(true)
    // Different folders on POSIX.
    expect(isFolderApprovedOnThisDevice(storage, '/srv/site ', false)).toBe(false)
    expect(isFolderApprovedOnThisDevice(storage, '/srv/Site', false)).toBe(false)
    expect(isFolderApprovedOnThisDevice(storage, '/srv\\site', false)).toBe(false)
    // `..` is left to the OS, which resolves it after symlinks.
    expect(isFolderApprovedOnThisDevice(storage, '/srv/site/link/..', false)).toBe(false)
  })

  test('Windows paths compare without case and with either separator', () => {
    const storage = memoryStorage()
    approveFolderOnThisDevice(storage, 'C:\\Users\\Me\\Repo', false)
    expect(isFolderApprovedOnThisDevice(storage, 'c:/users/me/repo/', false)).toBe(true)
    expect(folderKey('\\\\Server\\Share\\Dir')).toBe('//server/share/dir')
    expect(folderKey('C:\\')).toBe('c:/')
    // A share is not the folder of the same name on the current drive.
    expect(folderKey('//host/share')).not.toBe(folderKey('/host/share'))
  })

  test('a note folder resolves against the vault, as the run does', () => {
    expect(resolveTaskFolder(undefined, '/vault')).toBe('/vault')
    expect(resolveTaskFolder('sub/dir', '/vault/')).toBe('/vault/sub/dir')
    expect(resolveTaskFolder('./sub', '/vault')).toBe('/vault/sub')
    expect(resolveTaskFolder('/abs', '/vault')).toBe('/abs')
    expect(resolveTaskFolder('C:\\abs', '/vault')).toBe('C:\\abs')
    expect(resolveTaskFolder('sub', undefined)).toBeUndefined()
  })

  test('a folder is shown without control, format, or line-separator characters', () => {
    expect(displayFolder('/srv/a\u202Etxt.exe/')).toBe('/srv/a\uFFFDtxt.exe')
    expect(displayFolder('/srv/a\nb')).toBe('/srv/a\uFFFDb')
    expect(displayFolder('/srv/a\u200Bb\u061Cc\u2028d\uFEFFe')).toBe(
      '/srv/a\uFFFDb\uFFFDc\uFFFDd\uFFFDe',
    )
  })

  test('a task name loses direction characters but keeps emoji whole', () => {
    expect(displayName('Report\u202Efdp.exe')).toBe('Report\uFFFDfdp.exe')
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} plan'
    expect(displayName(family)).toBe(family)
  })

  test('broken storage approves nothing and never throws', () => {
    const broken: FolderConsentStorage = {
      loadLocalStorage: () => {
        throw new Error('unavailable')
      },
      saveLocalStorage: () => {
        throw new Error('unavailable')
      },
    }
    expect(isFolderApprovedOnThisDevice(broken, '/srv/work', false)).toBe(false)
    expect(() => approveFolderOnThisDevice(broken, '/srv/work', true)).not.toThrow()
    expect(isFolderApprovedOnThisDevice({ loadLocalStorage: () => 'nope' }, '/srv/work', false))
      .toBe(false)
  })

  test('what a run needs approved', () => {
    const storage = memoryStorage({
      [AI_APPROVED_FOLDERS_STORAGE_KEY]: ['/srv/approved'],
      [AI_TRUSTED_FOLDERS_STORAGE_KEY]: ['/srv/trusted'],
    })
    const need = (cwd: string | undefined, cwdIsVault: boolean, trust: boolean) =>
      folderConsentNeeded(storage, { cwd, cwdIsVault, trust })

    // The vault needs nothing, unless the task also trusts it.
    expect(need('/vault', true, false)).toBeNull()
    expect(need('/vault', true, true)).toEqual({ folder: '/vault', trust: true })
    // Another folder needs approval; trusting it needs its own.
    expect(need('/Users/me', false, false)).toEqual({ folder: '/Users/me', trust: false })
    expect(need('/srv/approved', false, false)).toBeNull()
    expect(need('/srv/approved', false, true)).toEqual({ folder: '/srv/approved', trust: true })
    expect(need('/srv/trusted', false, true)).toBeNull()
    expect(need(undefined, false, true)).toBeNull()
  })
})
