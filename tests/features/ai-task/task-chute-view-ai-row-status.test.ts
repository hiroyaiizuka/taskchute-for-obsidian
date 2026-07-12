/**
 * TaskChuteView row-status listener (mountAiRunPane) carried fixes:
 *   - shell-session status changes never trigger task-list re-renders (shell
 *     sessions render no row chip)
 *   - duplicate status notifications stay deduped per run
 *   - 'persisted' prunes the run's bookkeeping entry so aiRunRowStatuses does
 *     not grow for the lifetime of the view
 */
import { WorkspaceLeaf } from 'obsidian'
import { TaskChuteView } from '../../../src/features/core/views/TaskChuteView'
import type { AiRunChangeType } from '../../../src/features/ai-task/services/AiTaskManager'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
import type { TaskChutePluginLike } from '../../../src/types'

type ChangeListener = (record: AiRunRecord, changeType?: AiRunChangeType) => void

interface ManagerStub {
  startRun: jest.Mock
  stopRun: jest.Mock
  getRuns: jest.Mock<AiRunRecord[], []>
  getRun: jest.Mock
  getActiveRunForTask: jest.Mock
  onChange: jest.Mock<() => void, [ChangeListener]>
  onTerminalData: jest.Mock
  sendTerminalInput: jest.Mock
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
}

function createManagerStub(): { manager: ManagerStub; listeners: ChangeListener[] } {
  const listeners: ChangeListener[] = []
  const manager: ManagerStub = {
    startRun: jest.fn(),
    stopRun: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    onChange: jest.fn((listener: ChangeListener) => {
      listeners.push(listener)
      return jest.fn()
    }),
    onTerminalData: jest.fn(() => jest.fn()),
    sendTerminalInput: jest.fn(),
    invalidateBinaryCache: jest.fn(),
    dispose: jest.fn(),
  }
  return { manager, listeners }
}

function createPluginStub(): TaskChutePluginLike {
  return {
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
        getFiles: jest.fn(() => []),
        read: jest.fn(async () => ''),
        on: jest.fn(() => ({ detach: jest.fn() })),
        adapter: {
          stat: jest.fn(async () => ({ ctime: Date.now(), mtime: Date.now() })),
          exists: jest.fn(async () => false),
          read: jest.fn(async () => '{}'),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
      },
      metadataCache: { getFileCache: jest.fn(() => null) },
      workspace: { openLinkText: jest.fn() },
    },
    settings: {
      slotKeys: {},
      useOrderBasedSort: true,
      taskFolderPath: 'TASKS',
      projectFolderPath: 'PROJECTS',
      logDataPath: 'LOGS',
      reviewDataPath: 'REVIEWS',
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
    manifest: { id: 'taskchute-plus' },
  } as unknown as TaskChutePluginLike
}

interface ViewInternals {
  mountAiRunPane(): void
  aiPaneContainer: HTMLElement | null
}

function makeRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'ai-run-1',
    taskPath: 'TASKS/ai-task.md',
    taskName: 'ai-task',
    host: 'claude',
    mode: 'terminal',
    status: 'starting',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

function setUp(): {
  view: TaskChuteView
  rowListener: ChangeListener
  renderTaskList: jest.Mock
} {
  const plugin = createPluginStub()
  const { manager, listeners } = createManagerStub()
  ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
  const leaf = { containerEl: document.createElement('div') } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  const renderTaskList = jest.fn()
  view.renderTaskList = renderTaskList

  const internals = view as unknown as ViewInternals
  internals.aiPaneContainer = document.body.createDiv()
  internals.mountAiRunPane()

  // Subscription order: the pane controller first, the row-status refresher
  // second.
  expect(listeners).toHaveLength(2)
  return { view, rowListener: listeners[1], renderTaskList }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('TaskChuteView AI row-status listener', () => {
  test('shell-session status changes never re-render the task list', () => {
    const { rowListener, renderTaskList } = setUp()
    const shell = makeRecord({ id: 'shell-1', host: 'shell', taskPath: '' })

    rowListener({ ...shell, status: 'starting' }, 'update')
    rowListener({ ...shell, status: 'running' }, 'update')
    rowListener({ ...shell, status: 'stopped' }, 'update')
    rowListener({ ...shell, status: 'stopped' }, 'persisted')

    expect(renderTaskList).not.toHaveBeenCalled()
  })

  test('task-run status changes re-render once per distinct status', () => {
    const { rowListener, renderTaskList } = setUp()
    const record = makeRecord()

    rowListener({ ...record, status: 'running' }, 'update')
    rowListener({ ...record, status: 'running' }, 'update')
    expect(renderTaskList).toHaveBeenCalledTimes(1)

    rowListener({ ...record, status: 'stopped' }, 'update')
    expect(renderTaskList).toHaveBeenCalledTimes(2)
  })

  test("'persisted' prunes the run's status entry", () => {
    const { rowListener, renderTaskList } = setUp()
    const record = makeRecord()

    rowListener({ ...record, status: 'stopped' }, 'update')
    expect(renderTaskList).toHaveBeenCalledTimes(1)

    // 'persisted' itself never re-renders, but it must evict the entry:
    // the SAME status arriving afterwards dedupes against nothing.
    rowListener({ ...record, status: 'stopped' }, 'persisted')
    expect(renderTaskList).toHaveBeenCalledTimes(1)

    rowListener({ ...record, status: 'stopped' }, 'update')
    expect(renderTaskList).toHaveBeenCalledTimes(2)
  })
})
