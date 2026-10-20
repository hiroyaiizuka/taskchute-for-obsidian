import {
  AI_SKIP_PERMISSIONS_STORAGE_KEY,
  isSkipPermissionsAllowedOnThisDevice,
  resolveSkipPermissionsForRun,
  setSkipPermissionsAllowedOnThisDevice,
  type DeviceLocalStorage,
} from '@/features/ai-task/services/AiSkipPermissionsConsent'
import { aiTaskSection } from '@/settings/sections/pro/aiTask'
import type { AiTaskToggleGuard } from '@/settings/services/aiTaskLifecycle'
import type { SectionContext } from '@/settings/types'

// LEV-386: this device's consent to skip permissions, kept in Obsidian's
// per-vault local storage (never synced), and its switch in the settings.

function memoryStorage(): DeviceLocalStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    loadLocalStorage: (key) => values.get(key) ?? null,
    saveLocalStorage: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
    },
  }
}

describe('AiSkipPermissionsConsent', () => {
  test('is off until allowed, and turning it off forgets it', () => {
    const storage = memoryStorage()
    expect(isSkipPermissionsAllowedOnThisDevice(storage)).toBe(false)

    setSkipPermissionsAllowedOnThisDevice(storage, true)
    expect(storage.values.get(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(true)
    expect(isSkipPermissionsAllowedOnThisDevice(storage)).toBe(true)

    setSkipPermissionsAllowedOnThisDevice(storage, false)
    expect(storage.values.has(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(false)
    expect(isSkipPermissionsAllowedOnThisDevice(storage)).toBe(false)
  })

  test('only a stored true counts, and broken storage reads as not allowed', () => {
    expect(isSkipPermissionsAllowedOnThisDevice({ loadLocalStorage: () => 'true' })).toBe(false)
    expect(isSkipPermissionsAllowedOnThisDevice({})).toBe(false)
    expect(
      isSkipPermissionsAllowedOnThisDevice({
        loadLocalStorage: () => {
          throw new Error('storage unavailable')
        },
      }),
    ).toBe(false)
    expect(() =>
      setSkipPermissionsAllowedOnThisDevice(
        {
          saveLocalStorage: () => {
            throw new Error('storage unavailable')
          },
        },
        true,
      ),
    ).not.toThrow()
  })

  test('asks only on a manual start of a task that asks for it', async () => {
    const skip = { ai_task: true, ai_task_args: '--dangerously-skip-permissions' }
    const confirm = jest.fn(() => Promise.resolve(true))

    await expect(
      resolveSkipPermissionsForRun({ storage: memoryStorage(), frontmatter: skip, trigger: 'automatic', confirm }),
    ).resolves.toBe(false)
    await expect(
      resolveSkipPermissionsForRun({
        storage: memoryStorage(),
        frontmatter: { ai_task: true, ai_task_args: '--model opus' },
        trigger: 'manual',
        confirm,
      }),
    ).resolves.toBe(false)
    await expect(
      resolveSkipPermissionsForRun({ storage: memoryStorage(), frontmatter: { ai_task: false }, trigger: 'manual', confirm }),
    ).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()

    const storage = memoryStorage()
    await expect(
      resolveSkipPermissionsForRun({ storage, frontmatter: skip, trigger: 'manual', confirm }),
    ).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(isSkipPermissionsAllowedOnThisDevice(storage)).toBe(true)
  })
})

describe('the "Allow skip permissions on this device" setting', () => {
  test('reads and writes this device, not the plugin settings', async () => {
    const storage = memoryStorage()
    const settings: Record<string, unknown> = {}
    const ctx = {
      app: storage,
      plugin: { settings, saveSettings: jest.fn() },
      update: jest.fn(),
      refreshDomState: jest.fn(),
    } as unknown as SectionContext
    const handler = aiTaskSection({} as AiTaskToggleGuard).handlers?.['aiSkipPermissionsOnThisDevice']
    if (!handler) throw new Error('no handler for the device switch')

    expect(handler.read(ctx)).toBe(false)
    await handler.write(true, ctx)
    expect(handler.read(ctx)).toBe(true)
    expect(storage.values.get(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(true)
    await handler.write(false, ctx)
    expect(handler.read(ctx)).toBe(false)
    expect(settings).toEqual({})
  })
})
