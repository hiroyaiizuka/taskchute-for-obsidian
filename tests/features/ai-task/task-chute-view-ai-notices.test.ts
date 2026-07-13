/**
 * TaskChuteView AI Task integration edge cases:
 *   - user-facing notice paths when a run cannot start (no prompt section,
 *     binary not found, duplicate run, unexpected failure)
 *   - AI run pane lifecycle when the settings toggle flips while the view is
 *     open (mount on enable, clean unmount + unsubscribe on disable)
 */
import { Notice, TFile, WorkspaceLeaf } from 'obsidian'
import { TaskChuteView } from '../../../src/features/core/views/TaskChuteView'
import type { AiTaskManager } from '../../../src/features/ai-task/services/AiTaskManager'
import {
  AiPromptNotFoundError,
  AiRunAlreadyActiveError,
} from '../../../src/features/ai-task/services/AiTaskManager'
import { AiBinaryNotFoundError } from '../../../src/features/ai-task/services/BinaryLocator'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
import type { TaskChutePluginLike, TaskInstance } from '../../../src/types'

const TASK_PATH = 'TASKS/ai-task.md'

interface ManagerStub {
  startRun: jest.Mock<Promise<AiRunRecord>, [TFile]>
  stopRun: jest.Mock
  getRuns: jest.Mock
  getRun: jest.Mock
  getActiveRunForTask: jest.Mock
  onChange: jest.Mock<() => void, [(record: AiRunRecord) => void]>
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
}

function createManagerStub(): { manager: ManagerStub; unsubscribe: jest.Mock } {
  const unsubscribe = jest.fn()
  const manager: ManagerStub = {
    startRun: jest.fn(),
    stopRun: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    onChange: jest.fn(() => unsubscribe),
    invalidateBinaryCache: jest.fn(),
    dispose: jest.fn(),
  }
  return { manager, unsubscribe }
}

function createPluginStub(): TaskChutePluginLike {
  return {
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
        getFiles: jest.fn(() => []),
        read: jest.fn(async () => ''),
        modify: jest.fn(),
        create: jest.fn(),
        on: jest.fn(() => ({ detach: jest.fn() })),
        adapter: {
          stat: jest.fn(async () => ({ ctime: Date.now(), mtime: Date.now() })),
          exists: jest.fn(async () => false),
          read: jest.fn(async () => '{}'),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn(() => null),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
      setting: {
        open: jest.fn(),
        openTabById: jest.fn(),
      },
      commands: {
        commands: {},
        executeCommandById: jest.fn(),
      },
    },
    settings: {
      slotKeys: {},
      useOrderBasedSort: true,
      taskFolderPath: 'TASKS',
      projectFolderPath: 'PROJECTS',
      logDataPath: 'LOGS',
      reviewDataPath: 'REVIEWS',
      aiRobotButtonEnabled: false,
      aiTaskEnabled: true,
    },
    saveSettings: jest.fn(),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn(),
      getLogYearPath: (year: string | number) => `${year}`,
      ensureYearFolder: jest.fn(async (year: string | number) => `${year}`),
      validatePath: () => ({ valid: true }),
    },
    dayStateService: {
      loadDay: jest.fn(async () => ({
        hiddenRoutines: [],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: {},
        orders: {},
      })),
      saveDay: jest.fn(async () => undefined),
      consumeLocalStateWrite: jest.fn(() => false),
    },
    routineAliasService: {
      getRouteNameFromAlias: jest.fn((name: string) => name),
      loadAliases: jest.fn().mockResolvedValue({}),
    },
    manifest: {
      id: 'taskchute-plus',
    },
    _notify: jest.fn(),
  } as unknown as TaskChutePluginLike
}

interface ViewInternals {
  startAiRun(inst: TaskInstance): Promise<void>
  mountAiRunPane(): void
  aiPaneContainer: HTMLElement | null
}

function createView(plugin: TaskChutePluginLike): {
  view: TaskChuteView
  internals: ViewInternals
} {
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  view.renderTaskList = jest.fn()
  return { view, internals: view as unknown as ViewInternals }
}

function makeTaskFile(path = TASK_PATH, basename = 'ai-task'): TFile {
  const file = new TFile()
  file.path = path
  file.basename = basename
  file.extension = 'md'
  return file
}

function makeInstance(file: TFile | null = makeTaskFile()): TaskInstance {
  return {
    task: {
      file,
      frontmatter: { ai_task: true },
      path: file?.path ?? TASK_PATH,
      name: 'ai-task',
    },
    instanceId: 'inst-1',
    state: 'idle',
    slotKey: 'none',
  } as TaskInstance
}

function makeRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'ai-run-1',
    taskPath: TASK_PATH,
    taskName: 'ai-task',
    host: 'claude',
    mode: 'headless',
    status: 'running',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

function noticeMessages(): string[] {
  return (Notice as unknown as jest.Mock).mock.calls.map((call) => String(call[0]))
}

beforeEach(() => {
  ;(Notice as unknown as jest.Mock).mockClear()
})

describe('TaskChuteView AI run notices', () => {
  function setUp(): {
    manager: ManagerStub
    internals: ViewInternals
    view: TaskChuteView
  } {
    const plugin = createPluginStub()
    const { manager } = createManagerStub()
    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
    const { view, internals } = createView(plugin)
    return { manager, internals, view }
  }

  test('shows the no-prompt notice when the note lacks a prompt section', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockRejectedValueOnce(new AiPromptNotFoundError(TASK_PATH))

    await internals.startAiRun(makeInstance())

    expect(noticeMessages()).toEqual([
      expect.stringContaining('No prompt section found'),
    ])
  })

  test('shows the binary-not-found notice naming the host', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockRejectedValueOnce(new AiBinaryNotFoundError('codex'))

    await internals.startAiRun(makeInstance())

    const messages = noticeMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('was not found')
    expect(messages[0]).toContain('codex')
  })

  test('shows the duplicate-run notice when a run is already active', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockRejectedValueOnce(new AiRunAlreadyActiveError(TASK_PATH))

    await internals.startAiRun(makeInstance())

    expect(noticeMessages()).toEqual([
      expect.stringContaining('already in progress'),
    ])
  })

  test('shows a generic failure notice with the error message otherwise', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockRejectedValueOnce(new Error('spawn EACCES'))

    await internals.startAiRun(makeInstance())

    const messages = noticeMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Failed to start AI run')
    expect(messages[0]).toContain('spawn EACCES')
  })

  test('shows a failure notice when the task instance has no file', async () => {
    const { manager, internals } = setUp()

    await internals.startAiRun(makeInstance(null))

    expect(manager.startRun).not.toHaveBeenCalled()
    expect(noticeMessages()).toEqual([
      expect.stringContaining('Failed to start AI run'),
    ])
  })

  test('does not show a notice and re-renders the list on success', async () => {
    const { manager, internals, view } = setUp()
    manager.startRun.mockResolvedValueOnce(makeRecord())

    await internals.startAiRun(makeInstance())

    expect(noticeMessages()).toEqual([])
    expect(view.renderTaskList).toHaveBeenCalled()
  })
})

describe('TaskChuteView AI pane lifecycle on settings changes', () => {
  test('disabling the feature mid-run unmounts the pane and unsubscribes', () => {
    const plugin = createPluginStub()
    const { manager, unsubscribe } = createManagerStub()
    manager.getRuns.mockReturnValue([makeRecord()])
    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
    const { view, internals } = createView(plugin)

    const paneContainer = document.body.createDiv()
    internals.aiPaneContainer = paneContainer
    internals.mountAiRunPane()

    expect(paneContainer.querySelector('.ai-run-pane')).not.toBeNull()
    // The pane owns the only run-status subscription. Task rows keep the
    // same robot control while running and need no status refresher.
    expect(manager.onChange).toHaveBeenCalledTimes(1)

    // Settings toggle OFF: the SettingsTab disposes the manager and clears
    // plugin.aiTaskManager before notifying open views.
    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = undefined
    view.onAiTaskSettingsChanged()

    expect(paneContainer.querySelector('.ai-run-pane')).toBeNull()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(view.renderTaskList).toHaveBeenCalled()
    paneContainer.remove()
  })

  test('re-enabling the feature mounts the pane again', () => {
    const plugin = createPluginStub()
    const { manager } = createManagerStub()
    const { view, internals } = createView(plugin)

    const paneContainer = document.body.createDiv()
    internals.aiPaneContainer = paneContainer

    // Disabled at open time: nothing mounts.
    internals.mountAiRunPane()
    expect(paneContainer.querySelector('.ai-run-pane')).toBeNull()

    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager =
      manager as unknown as AiTaskManager
    view.onAiTaskSettingsChanged()

    expect(paneContainer.querySelector('.ai-run-pane')).not.toBeNull()
    paneContainer.remove()
  })

  test('onAiTaskSettingsChanged while disabled is a safe no-op', () => {
    const plugin = createPluginStub()
    const { view, internals } = createView(plugin)
    internals.aiPaneContainer = null

    expect(() => {
      view.onAiTaskSettingsChanged()
      view.onAiTaskSettingsChanged()
    }).not.toThrow()
    expect(view.renderTaskList).toHaveBeenCalledTimes(2)
  })
})
