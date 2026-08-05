/**
 * TaskChuteView AI board-view state:
 *   - restored from app.loadLocalStorage('taskchute-plus.ai-task-board-view')
 *     when the view is created; invalid/missing values fall back to 'mixed'
 *   - setAiTaskBoardView persists per device via app.saveLocalStorage and
 *     re-renders the task list immediately
 *   - with the AI Task feature disabled the effective view is ALWAYS 'mixed'
 *     (a stored 'ai'/'human' from an earlier session never filters the board)
 *   - regression: updateTotalTasksCount derives from the FULL
 *     view.taskInstances, never from the filtered render
 */
import { WorkspaceLeaf } from 'obsidian'
import {
  TaskChuteView,
  AI_TASK_BOARD_VIEW_STORAGE_KEY,
} from '../../../src/features/core/views/TaskChuteView'
import type { TaskChutePluginLike, TaskInstance } from '../../../src/types'

interface LocalStorageMocks {
  loadLocalStorage: jest.Mock
  saveLocalStorage: jest.Mock
}

function createPluginStub(storedBoardView?: unknown): {
  plugin: TaskChutePluginLike
  storage: LocalStorageMocks
} {
  const storage: LocalStorageMocks = {
    loadLocalStorage: jest.fn((key: string) =>
      key === AI_TASK_BOARD_VIEW_STORAGE_KEY ? storedBoardView ?? null : null,
    ),
    saveLocalStorage: jest.fn(),
  }
  const plugin = {
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
      commands: {
        commands: {},
        executeCommandById: jest.fn(),
      },
      loadLocalStorage: storage.loadLocalStorage,
      saveLocalStorage: storage.saveLocalStorage,
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
    manifest: { id: 'taskchute-plus' },
    _notify: jest.fn(),
  } as unknown as TaskChutePluginLike
  return { plugin, storage }
}

function createView(
  plugin: TaskChutePluginLike,
  options: { withManager?: boolean } = {},
): TaskChuteView {
  if (options.withManager !== false) {
    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = {
      getRuns: jest.fn(() => []),
      getRun: jest.fn(() => undefined),
      getActiveRunForTask: jest.fn(() => undefined),
      onChange: jest.fn(() => jest.fn()),
      stopRun: jest.fn(),
      requestStopForTask: jest.fn(),
      dispose: jest.fn(),
    }
  }
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  view.renderTaskList = jest.fn()
  return view
}

function makeInstance(path: string, aiTask: boolean): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: aiTask ? { ai_task: true } : {},
      path,
      name: path,
    },
    instanceId: `inst-${path}`,
    state: 'idle',
    slotKey: 'none',
  } as TaskInstance
}

describe('TaskChuteView board view state', () => {
  test("defaults to 'mixed' when nothing is stored", () => {
    const { plugin } = createPluginStub()
    const view = createView(plugin)

    expect(view.getAiTaskBoardView()).toBe('mixed')
  })

  test('restores the stored view on creation', () => {
    const { plugin, storage } = createPluginStub('ai')
    const view = createView(plugin)

    expect(view.getAiTaskBoardView()).toBe('ai')
    expect(storage.loadLocalStorage).toHaveBeenCalledWith(
      AI_TASK_BOARD_VIEW_STORAGE_KEY,
    )
  })

  test("an invalid stored value falls back to 'mixed'", () => {
    const { plugin } = createPluginStub('everything')
    const view = createView(plugin)

    expect(view.getAiTaskBoardView()).toBe('mixed')
  })

  test('a plugin app without the localStorage helpers still constructs (mixed)', () => {
    const { plugin } = createPluginStub()
    delete (plugin.app as { loadLocalStorage?: unknown }).loadLocalStorage
    delete (plugin.app as { saveLocalStorage?: unknown }).saveLocalStorage

    const view = createView(plugin)
    expect(view.getAiTaskBoardView()).toBe('mixed')
    // The setter must not crash either.
    view.setAiTaskBoardView('ai')
    expect(view.getAiTaskBoardView()).toBe('ai')
  })

  test('setAiTaskBoardView persists the choice and re-renders immediately', () => {
    const { plugin, storage } = createPluginStub()
    const view = createView(plugin)

    view.setAiTaskBoardView('human')

    expect(storage.saveLocalStorage).toHaveBeenCalledWith(
      AI_TASK_BOARD_VIEW_STORAGE_KEY,
      'human',
    )
    expect(view.renderTaskList).toHaveBeenCalledTimes(1)
    expect(view.getAiTaskBoardView()).toBe('human')
  })

  test("the effective view is 'mixed' while the feature is disabled, even with a stored filter", () => {
    const { plugin } = createPluginStub('ai')
    const view = createView(plugin, { withManager: false })

    expect(view.getAiTaskBoardView()).toBe('mixed')
  })

  test('switching to a view that hides the selected task clears the keyboard selection', () => {
    const { plugin } = createPluginStub()
    const view = createView(plugin)
    const aiInst = makeInstance('TASKS/ai-a.md', true)
    const humanInst = makeInstance('TASKS/human.md', false)
    view.taskInstances = [aiInst, humanInst]
    const selection = (
      view as unknown as {
        taskSelectionController: {
          select(inst: TaskInstance, element: HTMLElement): void
          getSelectedInstance(): TaskInstance | null
        }
      }
    ).taskSelectionController

    selection.select(aiInst, document.createElement('div'))
    expect(selection.getSelectedInstance()).toBe(aiInst)

    // 'human' hides the selected AI task: hotkeys (duplicate/delete/reset)
    // must not keep acting on an invisible row.
    view.setAiTaskBoardView('human')
    expect(selection.getSelectedInstance()).toBeNull()
  })

  test('switching views keeps a selection that stays visible', () => {
    const { plugin } = createPluginStub()
    const view = createView(plugin)
    const aiInst = makeInstance('TASKS/ai-a.md', true)
    const humanInst = makeInstance('TASKS/human.md', false)
    view.taskInstances = [aiInst, humanInst]
    const selection = (
      view as unknown as {
        taskSelectionController: {
          select(inst: TaskInstance, element: HTMLElement): void
          getSelectedInstance(): TaskInstance | null
        }
      }
    ).taskSelectionController

    selection.select(humanInst, document.createElement('div'))

    view.setAiTaskBoardView('human')
    expect(selection.getSelectedInstance()).toBe(humanInst)

    view.setAiTaskBoardView('mixed')
    expect(selection.getSelectedInstance()).toBe(humanInst)
  })

  test('regression: updateTotalTasksCount counts ALL instances regardless of the board filter', async () => {
    const { plugin } = createPluginStub('human')
    const view = createView(plugin)
    view.taskInstances = [
      makeInstance('TASKS/ai-a.md', true),
      makeInstance('TASKS/ai-b.md', true),
      makeInstance('TASKS/human.md', false),
    ]
    const updateDailySummaryTotals = jest.fn<Promise<void>, [string, number]>(
      async () => undefined,
    )
    ;(view as unknown as {
      executionLogService: { updateDailySummaryTotals: jest.Mock }
    }).executionLogService = { updateDailySummaryTotals }

    expect(view.getAiTaskBoardView()).toBe('human')
    ;(view as unknown as { updateTotalTasksCount(): void }).updateTotalTasksCount()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(updateDailySummaryTotals).toHaveBeenCalledTimes(1)
    // Two AI tasks are hidden from the 'human' board, but the daily summary
    // total still counts all three instances.
    expect(updateDailySummaryTotals.mock.calls[0][1]).toBe(3)
  })
})
