/**
 * The AI task settings and the runtime lifecycle behind their toggle.
 *
 * The toggle is the only setting that starts and stops a process, and its
 * completion can land after a newer toggle or after a hot reload has replaced
 * the plugin instance. Those races are the bulk of what is tested here.
 */
import type { SettingDefinitionItem, SettingDefinitionRender } from 'obsidian'
import { Notice, Setting, mockApp } from 'obsidian'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { TaskChuteSettingTab } from '../../../src/settings/SettingsTab'
import { createAiTaskManager } from '../../../src/features/ai-task'
import { createFakeLicenseManager } from '../license/fakeLicenseManager'
import {
  findByKey,
  findByName,
  flatten,
} from '../../settings/definitionHelpers'

jest.mock('../../../src/features/ai-task', () => ({
  createAiTaskManager: jest.fn(),
}))

const selectFileMock = jest.fn<Promise<string | null>, [unknown?]>()
jest.mock(
  '../../../src/features/ai-task/services/ElectronDirectoryPicker',
  () => ({
    ElectronDirectoryPicker: jest.fn(() => ({ selectFile: selectFileMock })),
  }),
)

type FakeManager = {
  dispose: jest.Mock
  disposeAndWait: jest.Mock<Promise<void>, []>
  invalidateBinaryCache: jest.Mock
}

function createFakeManager(): FakeManager {
  // The real disposeAndWait() disposes and then waits for the broker to
  // confirm, so the fake keeps the two linked.
  const dispose = jest.fn()
  return {
    dispose,
    disposeAndWait: jest.fn(async () => {
      dispose()
    }),
    invalidateBinaryCache: jest.fn(),
  }
}

interface FakePlugin {
  app: typeof mockApp
  manifest: { id: string; version: string }
  settings: Record<string, unknown>
  pathManager: { validatePath: () => { valid: boolean } }
  saveSettings: jest.Mock<Promise<void>, []>
  aiTaskManager?: FakeManager
  aiTaskManagersPendingDisposal?: Set<FakeManager>
  aiTaskLifecycleActive?: boolean
  aiTaskLifecycleGeneration?: number
}

function createTab(): { tab: TaskChuteSettingTab; plugin: FakePlugin } {
  const app = {
    ...mockApp,
    plugins: { plugins: {} },
  } as unknown as typeof mockApp

  const plugin: FakePlugin = {
    app,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: { slotKeys: {} },
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    aiTaskManagersPendingDisposal: new Set(),
    aiTaskLifecycleActive: true,
    aiTaskLifecycleGeneration: 1,
    // The AI settings only appear for an active license.
    licenseManager: createFakeLicenseManager(),
  } as FakePlugin
  ;(app as unknown as {
    plugins: { plugins: Record<string, unknown> }
  }).plugins.plugins['taskchute-plus'] = plugin

  const tab = new TaskChuteSettingTab(app as never, plugin as never)
  return { tab, plugin }
}

interface FakeTextComponent {
  getValue(): string
  setValue(value: string): FakeTextComponent
  __triggerEvent(type: string): Promise<void>
}

interface FakeExtraButton {
  icon: string | null
  tooltip: string | null
  __click(): Promise<void>
}

/**
 * The CLI path rows are imperative (`render:`) because the text field and its
 * picker share one row, so the test has to run the callback against a Setting
 * and reach for the components it created.
 */
function pathRow(
  tab: TaskChuteSettingTab,
  pathName: string,
): { text: FakeTextComponent; browse: FakeExtraButton } {
  const row = flatten(tab.getSettingDefinitions()).find(
    (item: SettingDefinitionItem): item is SettingDefinitionRender =>
      'render' in item && item.render !== undefined && item.name === pathName,
  )
  if (!row) throw new Error(`path row for "${pathName}" not found`)

  const setting = new Setting(document.createElement('div')) as unknown as {
    __textComponents?: FakeTextComponent[]
    __extraButtons?: FakeExtraButton[]
  }
  row.render(setting as never, undefined as never)

  const text = setting.__textComponents?.[0]
  const browse = setting.__extraButtons?.[0]
  if (!text || !browse) {
    throw new Error(`path row for "${pathName}" rendered no field or picker`)
  }
  return { text, browse }
}

/** Types into the field and commits the way the row does: on blur. */
async function typePath(
  tab: TaskChuteSettingTab,
  pathName: string,
  value: string,
): Promise<void> {
  const { text } = pathRow(tab, pathName)
  text.setValue(value)
  await text.__triggerEvent('blur')
}

const CLAUDE_PATH_NAME = 'Claude CLI path (advanced fallback)'
const CODEX_PATH_NAME = 'Codex CLI path (advanced fallback)'

describe('TaskChute AI task settings section', () => {
  const createAiTaskManagerMock = createAiTaskManager as jest.Mock

  afterEach(() => {
    jest.clearAllMocks()
    mockApp.workspace.getLeavesOfType.mockReturnValue([])
  })

  test('is disabled by default with a 30-day retention', () => {
    expect(DEFAULT_SETTINGS.aiTaskEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.aiTaskLogRetentionDays).toBe(30)
  })

  test('declares the AI settings only once the license is active', () => {
    const { tab } = createTab()

    const items = tab.getSettingDefinitions()
    expect(findByKey(items, 'aiTaskEnabled')?.name).toBe('Enable AI tasks')
    expect(findByKey(items, 'aiTaskRunMode')?.control.type).toBe('dropdown')
    expect(findByKey(items, 'aiTaskLogRetentionDays')?.control.type).toBe(
      'number',
    )
  })

  describe('the runtime toggle', () => {
    test('enabling creates the manager and notifies open views', async () => {
      const manager = createFakeManager()
      createAiTaskManagerMock.mockReturnValue(manager)
      const { tab, plugin } = createTab()
      const view = { onAiTaskSettingsChanged: jest.fn() }
      mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

      await tab.setControlValue('aiTaskEnabled', true)

      expect(plugin.settings.aiTaskEnabled).toBe(true)
      expect(plugin.saveSettings).toHaveBeenCalled()
      expect(createAiTaskManagerMock).toHaveBeenCalledWith(plugin)
      expect(plugin.aiTaskManager).toBe(manager)
      expect(view.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
    })

    test('disabling disposes the manager and notifies open views', async () => {
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskEnabled = true
      plugin.aiTaskManager = manager
      const view = { onAiTaskSettingsChanged: jest.fn() }
      mockApp.workspace.getLeavesOfType.mockReturnValue([{ view }])

      await tab.setControlValue('aiTaskEnabled', false)

      expect(plugin.settings.aiTaskEnabled).toBe(false)
      expect(manager.dispose).toHaveBeenCalledTimes(1)
      expect(manager.disposeAndWait).toHaveBeenCalledTimes(1)
      expect(plugin.aiTaskManager).toBeUndefined()
      expect(view.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
    })

    test('re-enabling waits for the previous broker shutdown', async () => {
      let finishShutdown: (() => void) | undefined
      const shutdown = new Promise<void>((resolve) => {
        finishShutdown = resolve
      })
      const oldManager = createFakeManager()
      oldManager.disposeAndWait.mockImplementation(() => shutdown)
      const replacementManager = createFakeManager()
      createAiTaskManagerMock.mockReturnValue(replacementManager)
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskEnabled = true
      plugin.aiTaskManager = oldManager

      await tab.setControlValue('aiTaskEnabled', false)
      const enabling = tab.setControlValue('aiTaskEnabled', true)
      await Promise.resolve()
      await Promise.resolve()

      expect(plugin.aiTaskManagersPendingDisposal?.has(oldManager)).toBe(true)
      expect(createAiTaskManagerMock).not.toHaveBeenCalled()

      finishShutdown?.()
      await enabling

      expect(createAiTaskManagerMock).toHaveBeenCalledWith(plugin)
      expect(plugin.aiTaskManager).toBe(replacementManager)
      expect(plugin.aiTaskManagersPendingDisposal?.has(oldManager)).toBe(false)
    })

    test('a failed prior shutdown keeps AI tasks disabled rather than racing', async () => {
      const oldManager = createFakeManager()
      oldManager.disposeAndWait.mockRejectedValue(new Error('broker still alive'))
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskEnabled = true
      plugin.aiTaskManager = oldManager

      await tab.setControlValue('aiTaskEnabled', false)
      await tab.setControlValue('aiTaskEnabled', true)

      expect(createAiTaskManagerMock).not.toHaveBeenCalled()
      expect(plugin.aiTaskManager).toBeUndefined()
      expect(plugin.settings.aiTaskEnabled).toBe(false)
      expect(plugin.aiTaskManagersPendingDisposal?.has(oldManager)).toBe(true)
      expect(Notice).toHaveBeenCalledWith(
        'The previous AI runtime could not be stopped safely. AI tasks remain disabled; please try again.',
      )
    })

    test('a save completed by an old plugin instance cannot adopt a manager', async () => {
      let finishSave: (() => void) | undefined
      const { tab, plugin } = createTab()
      plugin.saveSettings.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve
          }),
      )

      const pending = tab.setControlValue('aiTaskEnabled', true)
      await Promise.resolve()
      // A hot reload swaps the registry entry for a fresh plugin instance.
      const reloadedApp = {
        ...mockApp,
        plugins: { plugins: { 'taskchute-plus': { replacement: true } } },
      } as unknown as typeof mockApp
      plugin.app = reloadedApp
      finishSave?.()
      await pending

      expect(plugin.settings.aiTaskEnabled).toBe(true)
      expect(createAiTaskManagerMock).not.toHaveBeenCalled()
      expect(plugin.aiTaskManager).toBeUndefined()
    })

    test('an old disable callback cannot dispose the replacement plugin’s manager', async () => {
      let finishSave: (() => void) | undefined
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskEnabled = true
      plugin.aiTaskManager = manager
      plugin.saveSettings.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve
          }),
      )

      const pending = tab.setControlValue('aiTaskEnabled', false)
      await Promise.resolve()
      const replacement = { aiTaskManager: manager }
      ;(plugin.app as unknown as {
        plugins: { plugins: Record<string, unknown> }
      }).plugins.plugins['taskchute-plus'] = replacement
      finishSave?.()
      await pending

      expect(manager.dispose).not.toHaveBeenCalled()
      expect(manager.disposeAndWait).not.toHaveBeenCalled()
      expect(replacement.aiTaskManager).toBe(manager)
    })

    test('an unload-started callback cannot dispose while the registry is stale', async () => {
      let finishSave: (() => void) | undefined
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskEnabled = true
      plugin.aiTaskManager = manager
      plugin.saveSettings.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve
          }),
      )

      const pending = tab.setControlValue('aiTaskEnabled', false)
      await Promise.resolve()

      // Hostile event order: onunload has begun, but Obsidian has not replaced
      // the old instance in its plugin registry yet.
      plugin.aiTaskLifecycleActive = false
      plugin.aiTaskLifecycleGeneration = 2
      expect(
        (plugin.app as unknown as {
          plugins: { plugins: Record<string, unknown> }
        }).plugins.plugins['taskchute-plus'],
      ).toBe(plugin)

      finishSave?.()
      await pending

      expect(manager.dispose).not.toHaveBeenCalled()
      expect(manager.disposeAndWait).not.toHaveBeenCalled()
      expect(plugin.aiTaskManager).toBe(manager)
    })

    test('only the newest toggle applies when saves complete out of order', async () => {
      const saveResolvers: Array<() => void> = []
      const { tab, plugin } = createTab()
      plugin.saveSettings.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            saveResolvers.push(resolve)
          }),
      )

      const enable = tab.setControlValue('aiTaskEnabled', true)
      await Promise.resolve()
      const disable = tab.setControlValue('aiTaskEnabled', false)
      await Promise.resolve()
      saveResolvers[1]?.()
      await disable
      saveResolvers[0]?.()
      await enable

      expect(plugin.settings.aiTaskEnabled).toBe(false)
      expect(createAiTaskManagerMock).not.toHaveBeenCalled()
      expect(plugin.aiTaskManager).toBeUndefined()
    })
  })

  describe('run mode', () => {
    test('offers terminal and headless, defaulting to terminal', () => {
      const { tab } = createTab()

      const control = findByKey(tab.getSettingDefinitions(), 'aiTaskRunMode')
        ?.control as { options: Record<string, string> } | undefined
      expect(Object.keys(control?.options ?? {})).toEqual([
        'terminal',
        'headless',
      ])
      expect(tab.getControlValue('aiTaskRunMode')).toBe('terminal')
    })

    test('reflects a stored headless preference', () => {
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskRunMode = 'headless'

      expect(tab.getControlValue('aiTaskRunMode')).toBe('headless')
    })

    test('persists a change and normalizes anything unknown', async () => {
      const { tab, plugin } = createTab()

      await tab.setControlValue('aiTaskRunMode', 'headless')
      expect(plugin.settings.aiTaskRunMode).toBe('headless')
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1)

      await tab.setControlValue('aiTaskRunMode', 'bogus')
      expect(plugin.settings.aiTaskRunMode).toBe('terminal')
    })
  })

  describe('CLI paths', () => {
    test('carry their picker on the same row as the field', () => {
      const { tab } = createTab()

      // A stray "Browse" row of its own would mean the picker drifted back out
      // of the field's row.
      expect(findByName(tab.getSettingDefinitions(), 'Browse')).toBeUndefined()

      const { browse } = pathRow(tab, CLAUDE_PATH_NAME)
      expect(browse.icon).toBe('folder')
      expect(browse.tooltip).toBe('Browse')
    })

    test('trim on the way in and invalidate the locator cache', async () => {
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.aiTaskManager = manager

      await typePath(tab, CLAUDE_PATH_NAME, '  /opt/homebrew/bin/claude  ')
      await typePath(tab, CODEX_PATH_NAME, ' ')

      expect(plugin.settings.aiTaskClaudePath).toBe('/opt/homebrew/bin/claude')
      expect(plugin.settings.aiTaskCodexPath).toBe('')
      expect(plugin.saveSettings).toHaveBeenCalledTimes(2)
      expect(manager.invalidateBinaryCache).toHaveBeenCalledTimes(2)
    })

    test('leave the stored path alone when a blur changed nothing', async () => {
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.aiTaskManager = manager
      plugin.settings.aiTaskClaudePath = '/opt/homebrew/bin/claude'

      const { text } = pathRow(tab, CLAUDE_PATH_NAME)
      await text.__triggerEvent('blur')

      expect(plugin.saveSettings).not.toHaveBeenCalled()
      expect(manager.invalidateBinaryCache).not.toHaveBeenCalled()
    })

    test('reject Windows command shims with a visible notice', async () => {
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.aiTaskManager = manager

      await typePath(
        tab,
        CLAUDE_PATH_NAME,
        'C:\\Users\\tester\\AppData\\Roaming\\npm\\claude.cmd',
      )
      await typePath(
        tab,
        CODEX_PATH_NAME,
        'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.ps1',
      )

      expect(plugin.settings.aiTaskClaudePath).toBe('')
      expect(plugin.settings.aiTaskCodexPath).toBe('')
      // The rejection rebuilds the tab, so the re-rendered field is empty too.
      expect(pathRow(tab, CLAUDE_PATH_NAME).text.getValue()).toBe('')
      expect(Notice).toHaveBeenCalledTimes(2)
      expect(manager.invalidateBinaryCache).toHaveBeenCalledTimes(2)
    })

    test('browsing writes the picked file into the setting', async () => {
      const manager = createFakeManager()
      const { tab, plugin } = createTab()
      plugin.aiTaskManager = manager
      selectFileMock.mockResolvedValue('/opt/homebrew/bin/claude')

      await pathRow(tab, CLAUDE_PATH_NAME).browse.__click()

      expect(plugin.settings.aiTaskClaudePath).toBe('/opt/homebrew/bin/claude')
      expect(manager.invalidateBinaryCache).toHaveBeenCalledTimes(1)
    })

    test('cancelling the picker leaves the stored path untouched', async () => {
      const { tab, plugin } = createTab()
      plugin.settings.aiTaskClaudePath = '/existing/claude'
      selectFileMock.mockResolvedValue(null)

      await pathRow(tab, CLAUDE_PATH_NAME).browse.__click()

      expect(plugin.settings.aiTaskClaudePath).toBe('/existing/claude')
      expect(plugin.saveSettings).not.toHaveBeenCalled()
    })
  })

  test('retention days clamp instead of rejecting', async () => {
    const { tab, plugin } = createTab()

    await tab.setControlValue('aiTaskLogRetentionDays', 0)
    expect(plugin.settings.aiTaskLogRetentionDays).toBe(1)

    await tab.setControlValue('aiTaskLogRetentionDays', 45.4)
    expect(plugin.settings.aiTaskLogRetentionDays).toBe(45)

    await tab.setControlValue('aiTaskLogRetentionDays', Number.NaN)
    expect(plugin.settings.aiTaskLogRetentionDays).toBe(30)
  })
})
