/**
 * TaskChuteView intentionally has no row-status listener: task rows keep the
 * same robot control while running, so only AiRunPaneController subscribes to
 * manager changes and task-list rendering is decoupled from run status.
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
  paneListener: ChangeListener
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

  expect(listeners).toHaveLength(1)
  return { paneListener: listeners[0], renderTaskList }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('TaskChuteView AI pane status subscription', () => {
  test('run-status changes are handled by the pane without re-rendering task rows', () => {
    const { paneListener, renderTaskList } = setUp()
    const record = makeRecord()

    paneListener({ ...record, status: 'running' }, 'update')
    paneListener({ ...record, status: 'stopped' }, 'update')
    expect(renderTaskList).not.toHaveBeenCalled()
  })
})
