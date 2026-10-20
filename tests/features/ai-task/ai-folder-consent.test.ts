import {
  AI_APPROVED_FOLDERS_STORAGE_KEY,
  approveFolderOnThisDevice,
  folderConsentNeeded,
  isFolderApprovedOnThisDevice,
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
  test('a folder picked in the task settings on this device is approved', () => {
    const storage = memoryStorage({
      [WORKING_DIRECTORY_HISTORY_STORAGE_KEY]: ['/Users/me/Projects/app'],
    })
    expect(isFolderApprovedOnThisDevice(storage, '/Users/me/Projects/app/')).toBe(true)
    expect(isFolderApprovedOnThisDevice(storage, '/Users/me')).toBe(false)
  })

  test('approving keeps the folder on this device, once', () => {
    const storage = memoryStorage()
    approveFolderOnThisDevice(storage, '/srv/work/')
    approveFolderOnThisDevice(storage, '/srv/work')
    expect(storage.values.get(AI_APPROVED_FOLDERS_STORAGE_KEY)).toEqual(['/srv/work'])
    expect(isFolderApprovedOnThisDevice(storage, '/srv/work')).toBe(true)
  })

  test('Windows paths compare without case', () => {
    const storage = memoryStorage()
    approveFolderOnThisDevice(storage, 'C:\\Users\\Me\\Repo')
    expect(isFolderApprovedOnThisDevice(storage, 'c:/users/me/repo')).toBe(true)
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
    expect(isFolderApprovedOnThisDevice(broken, '/srv/work')).toBe(false)
    expect(() => approveFolderOnThisDevice(broken, '/srv/work')).not.toThrow()
    expect(isFolderApprovedOnThisDevice({ loadLocalStorage: () => 'nope' }, '/srv/work')).toBe(false)
  })

  test('what a run needs approved', () => {
    const storage = memoryStorage({ [AI_APPROVED_FOLDERS_STORAGE_KEY]: ['/srv/approved'] })
    const need = (cwd: string | undefined, cwdIsVault: boolean, trust: boolean) =>
      folderConsentNeeded({ storage, cwd, cwdIsVault, trust })

    // The vault needs nothing, unless the task also trusts it.
    expect(need('/vault', true, false)).toBeNull()
    expect(need('/vault', true, true)).toEqual({ folder: '/vault', trust: true })
    // Another folder needs approval, with or without trust.
    expect(need('/Users/me', false, false)).toEqual({ folder: '/Users/me', trust: false })
    expect(need('/srv/approved', false, true)).toBeNull()
    expect(need(undefined, false, true)).toBeNull()
  })
})
