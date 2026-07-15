import { TFile } from 'obsidian'

import { createAiTaskAmbientScheduler } from '../../../src/features/ai-task/AiTaskAmbientRuntime'
import { AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY } from '../../../src/features/ai-task/services/AiTaskAmbientScheduleStateStore'
import type { TaskChuteViewController } from '../../../src/app/taskchute/TaskChuteViewController'
import type { TaskChutePluginLike } from '../../../src/types'

const TASK_PATH = 'TaskChute/Task/Ambient review.md'
const DUE_AT = new Date(2026, 6, 15, 8, 0)
const STARTED_RUN = {
  runId: 'ai-run-ambient-1',
  path: TASK_PATH,
  instanceId: 'ambient-instance-1',
  startTime: new Date(2026, 6, 15, 8, 0, 0, 123).getTime(),
  slotKey: '8:00-12:00',
  originalSlotKey: 'none',
}

function createFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.split('/').pop()?.replace(/\.md$/u, '') ?? path
  file.extension = 'md'
  return file
}

function createHarness(options: {
  enabled?: boolean
  manager?: boolean
  linked?: boolean
} = {}) {
  const file = createFile(TASK_PATH)
  const saveLocalStorage = jest.fn()
  const runDueAmbientAiTasks = jest.fn(async () => ({
    satisfiedPaths: [TASK_PATH],
    startedRuns: [STARTED_RUN],
  }))
  const closeBackgroundView = jest.fn()
  const backgroundView = { runDueAmbientAiTasks }
  const createBackgroundView = jest.fn(async () => ({
    view: backgroundView,
    close: closeBackgroundView,
  }))
  const syncAmbientAiTaskRuns = jest.fn()
  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) =>
          path === 'TaskChute/Task'
            ? { path, children: [file] }
            : null,
        ),
      },
      metadataCache: {
        getFileCache: jest.fn(() => ({
          frontmatter: {
            taskId: 'ambient-review',
            ai_task: true,
            ai_task_host: 'claude',
            isRoutine: true,
            routine_type: 'daily',
            routine_enabled: true,
            scheduled_time: '08:00',
            ...(options.linked
              ? {
                  obsidian_sync: {
                    enabled: true,
                    taskTitle: 'Morning review',
                    matchType: 'exact',
                  },
                }
              : {}),
          },
        })),
      },
      loadLocalStorage: jest.fn(() => null),
      saveLocalStorage,
    },
    settings: {
      aiTaskEnabled: options.enabled !== false,
    },
    aiTaskManager: options.manager === false ? undefined : {},
    pathManager: {
      getTaskFolderPath: () => 'TaskChute/Task',
    },
    _log: jest.fn(),
  } as unknown as TaskChutePluginLike
  const viewController = {
    createBackgroundView,
    syncAmbientAiTaskRuns,
  } as unknown as TaskChuteViewController

  return {
    plugin,
    viewController,
    scheduler: createAiTaskAmbientScheduler(plugin, viewController),
    createBackgroundView,
    closeBackgroundView,
    backgroundView,
    runDueAmbientAiTasks,
    syncAmbientAiTaskRuns,
    saveLocalStorage,
  }
}

describe('AI Task Ambient runtime composition', () => {
  test('runs a due routine through a background TaskChute view and persists once-per-day state', async () => {
    const harness = createHarness()

    await harness.scheduler.checkNow(DUE_AT)
    await harness.scheduler.checkNow(new Date(2026, 6, 15, 8, 1))

    expect(harness.createBackgroundView).toHaveBeenCalledTimes(1)
    expect(harness.createBackgroundView).toHaveBeenCalledWith([
      'runDueAmbientAiTasks',
    ])
    expect(harness.closeBackgroundView).toHaveBeenCalledTimes(1)
    expect(harness.runDueAmbientAiTasks).toHaveBeenCalledWith(
      [TASK_PATH],
      DUE_AT,
    )
    expect(harness.syncAmbientAiTaskRuns).toHaveBeenCalledWith(
      harness.backgroundView,
      [STARTED_RUN],
      '2026-07-15',
    )
    expect(harness.saveLocalStorage).toHaveBeenCalledWith(
      AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY,
      expect.objectContaining({
        executions: expect.objectContaining({
          'taskId:ambient-review': expect.objectContaining({
            lastExecutedDate: '2026-07-15',
          }),
        }),
      }),
    )
  })

  test('does not create a view before the scheduled time', async () => {
    const harness = createHarness()

    await harness.scheduler.checkNow(new Date(2026, 6, 15, 7, 59))

    expect(harness.createBackgroundView).not.toHaveBeenCalled()
    expect(harness.saveLocalStorage).not.toHaveBeenCalled()
  })

  test('persists already-satisfied paths but syncs only newly started run snapshots', async () => {
    const harness = createHarness()
    harness.runDueAmbientAiTasks.mockResolvedValueOnce({
      satisfiedPaths: [TASK_PATH],
      startedRuns: [],
    })

    await harness.scheduler.checkNow(DUE_AT)

    expect(harness.syncAmbientAiTaskRuns).not.toHaveBeenCalled()
    expect(harness.saveLocalStorage).toHaveBeenCalledTimes(1)
  })

  test('does not persist or sync a path omitted from the background result', async () => {
    const harness = createHarness()
    harness.runDueAmbientAiTasks.mockResolvedValueOnce({
      satisfiedPaths: [],
      startedRuns: [],
    })

    await harness.scheduler.checkNow(DUE_AT)

    expect(harness.syncAmbientAiTaskRuns).not.toHaveBeenCalled()
    expect(harness.saveLocalStorage).not.toHaveBeenCalled()
    expect(harness.closeBackgroundView).toHaveBeenCalledTimes(1)
  })

  test('keeps an Obsidian-linked routine click-only', async () => {
    const harness = createHarness({ linked: true })

    await harness.scheduler.checkNow(DUE_AT)

    expect(harness.createBackgroundView).not.toHaveBeenCalled()
    expect(harness.runDueAmbientAiTasks).not.toHaveBeenCalled()
    expect(harness.saveLocalStorage).not.toHaveBeenCalled()
  })

  test.each([
    ['feature disabled', { enabled: false }],
    ['manager unavailable', { manager: false }],
  ])('stays inert when %s', async (_label, options) => {
    const harness = createHarness(options)

    await harness.scheduler.checkNow(DUE_AT)

    expect(harness.createBackgroundView).not.toHaveBeenCalled()
    expect(harness.saveLocalStorage).not.toHaveBeenCalled()
  })
})
