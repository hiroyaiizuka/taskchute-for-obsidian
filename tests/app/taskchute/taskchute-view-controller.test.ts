import { TaskChuteViewController } from '../../../src/app/taskchute/TaskChuteViewController'
import { VIEW_TYPE_TASKCHUTE } from '../../../src/types'

import type { TaskChutePluginLike } from '../../../src/types'

const STARTED_RUN = {
  runId: 'ai-run-ambient-1',
  path: 'TaskChute/Task/Ambient.md',
  instanceId: 'ambient-instance-1',
  startTime: new Date(2026, 6, 15, 8, 0, 0, 123).getTime(),
  slotKey: '8:00-12:00',
  originalSlotKey: 'none',
}

type MockLeaf = {
  view?: {
    getViewType?: () => string
    syncAmbientAiTaskRuns?: jest.Mock
  }
  setViewState?: jest.Mock<Promise<void>, [unknown]>
  detach?: jest.Mock
}

function createPlugin({
  activeLeaf,
  taskChuteLeaves,
}: {
  activeLeaf: MockLeaf | null
  taskChuteLeaves: MockLeaf[]
}): TaskChutePluginLike {
  return {
    app: {
      workspace: {
        getMostRecentLeaf: jest.fn().mockReturnValue(activeLeaf),
        getLeavesOfType: jest.fn().mockReturnValue(taskChuteLeaves),
      },
    },
  } as unknown as TaskChutePluginLike
}

describe('TaskChuteViewController isViewActive', () => {
  test('returns true when active leaf is TaskChute view', () => {
    const taskChuteLeaf: MockLeaf = {
      view: { getViewType: () => VIEW_TYPE_TASKCHUTE },
    }
    const plugin = createPlugin({
      activeLeaf: taskChuteLeaf,
      taskChuteLeaves: [taskChuteLeaf],
    })

    const controller = new TaskChuteViewController(plugin)

    expect(controller.isViewActive()).toBe(true)
  })

  test('returns false when TaskChute exists only in background leaf', () => {
    const taskChuteLeaf: MockLeaf = {
      view: { getViewType: () => VIEW_TYPE_TASKCHUTE },
    }
    const markdownLeaf: MockLeaf = {
      view: { getViewType: () => 'markdown' },
    }
    const plugin = createPlugin({
      activeLeaf: markdownLeaf,
      taskChuteLeaves: [taskChuteLeaf],
    })

    const controller = new TaskChuteViewController(plugin)

    expect(controller.isViewActive()).toBe(false)
  })
})

describe('TaskChuteViewController background activation', () => {
  test('creates a non-active tab without revealing it for Ambient execution', async () => {
    const backgroundLeaf: MockLeaf = {
      setViewState: jest.fn().mockResolvedValue(undefined),
    }
    const getLeaf = jest.fn(() => backgroundLeaf)
    const revealLeaf = jest.fn(async () => undefined)
    const plugin = {
      app: {
        workspace: {
          getMostRecentLeaf: jest.fn(() => null),
          getLeavesOfType: jest.fn(() => []),
          getLeaf,
          revealLeaf,
        },
      },
    } as unknown as TaskChutePluginLike

    const controller = new TaskChuteViewController(plugin)
    await controller.activateView({ reveal: false })

    expect(getLeaf).toHaveBeenCalledWith('tab')
    expect(backgroundLeaf.setViewState).toHaveBeenCalledWith({
      type: VIEW_TYPE_TASKCHUTE,
      active: false,
    })
    expect(revealLeaf).not.toHaveBeenCalled()
  })

  test('does not reveal an existing TaskChute leaf in background mode', async () => {
    const taskChuteLeaf: MockLeaf = {
      view: { getViewType: () => VIEW_TYPE_TASKCHUTE },
    }
    const revealLeaf = jest.fn(async () => undefined)
    const plugin = {
      app: {
        workspace: {
          getMostRecentLeaf: jest.fn(() => null),
          getLeavesOfType: jest.fn(() => [taskChuteLeaf]),
          revealLeaf,
        },
      },
    } as unknown as TaskChutePluginLike

    const controller = new TaskChuteViewController(plugin)
    await controller.activateView({ reveal: false })

    expect(revealLeaf).not.toHaveBeenCalled()
  })

  test('creates and closes an isolated background view for Ambient execution', async () => {
    const view = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      runDueAmbientAiTasks: jest.fn(),
    }
    const backgroundLeaf: MockLeaf = {
      view,
      setViewState: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn(),
    }
    const plugin = {
      app: {
        workspace: {
          getMostRecentLeaf: jest.fn(() => null),
          getLeaf: jest.fn(() => backgroundLeaf),
          revealLeaf: jest.fn(async () => undefined),
        },
      },
    } as unknown as TaskChutePluginLike

    const controller = new TaskChuteViewController(plugin)
    const session = await controller.createBackgroundView([
      'runDueAmbientAiTasks',
    ])

    expect(session?.view).toBe(view)
    expect(backgroundLeaf.setViewState).toHaveBeenCalledWith({
      type: VIEW_TYPE_TASKCHUTE,
      active: false,
    })
    expect(backgroundLeaf.detach).not.toHaveBeenCalled()

    session?.close()
    session?.close()
    expect(backgroundLeaf.detach).toHaveBeenCalledTimes(1)
  })

  test('restores the original leaf immediately and again if background owns focus at close', async () => {
    const originalLeaf: MockLeaf = {
      view: { getViewType: () => VIEW_TYPE_TASKCHUTE },
    }
    const backgroundView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      runDueAmbientAiTasks: jest.fn(),
    }
    let activeLeaf: MockLeaf | null = originalLeaf
    const backgroundLeaf: MockLeaf = {
      view: backgroundView,
      setViewState: jest.fn().mockImplementation(async () => {
        activeLeaf = backgroundLeaf
      }),
      detach: jest.fn(),
    }
    const setActiveLeaf = jest.fn((leaf: MockLeaf) => {
      activeLeaf = leaf
    })
    const plugin = {
      app: {
        workspace: {
          getMostRecentLeaf: jest.fn(() => activeLeaf),
          getLeaf: jest.fn(() => backgroundLeaf),
          setActiveLeaf,
        },
      },
    } as unknown as TaskChutePluginLike

    const controller = new TaskChuteViewController(plugin)
    const session = await controller.createBackgroundView([
      'runDueAmbientAiTasks',
    ])

    expect(setActiveLeaf).toHaveBeenCalledWith(originalLeaf, { focus: false })
    expect(activeLeaf).toBe(originalLeaf)

    // Defensive close-time restoration: Obsidian (or another internal
    // transition) can make the short-lived leaf active again before detach.
    activeLeaf = backgroundLeaf
    session?.close()

    expect(backgroundLeaf.detach).toHaveBeenCalledTimes(1)
    expect(setActiveLeaf).toHaveBeenCalledTimes(2)
    expect(setActiveLeaf).toHaveBeenLastCalledWith(originalLeaf, { focus: false })
    expect(activeLeaf).toBe(originalLeaf)
  })

  test('does not steal focus when the user selected another leaf during Ambient execution', async () => {
    const originalLeaf: MockLeaf = {
      view: { getViewType: () => VIEW_TYPE_TASKCHUTE },
    }
    const userSelectedLeaf: MockLeaf = {
      view: { getViewType: () => 'markdown' },
    }
    const backgroundView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      runDueAmbientAiTasks: jest.fn(),
    }
    let activeLeaf: MockLeaf | null = originalLeaf
    const backgroundLeaf: MockLeaf = {
      view: backgroundView,
      setViewState: jest.fn().mockImplementation(async () => {
        activeLeaf = backgroundLeaf
      }),
      detach: jest.fn(),
    }
    const setActiveLeaf = jest.fn((leaf: MockLeaf) => {
      activeLeaf = leaf
    })
    const plugin = {
      app: {
        workspace: {
          getMostRecentLeaf: jest.fn(() => activeLeaf),
          getLeaf: jest.fn(() => backgroundLeaf),
          setActiveLeaf,
        },
      },
    } as unknown as TaskChutePluginLike

    const controller = new TaskChuteViewController(plugin)
    const session = await controller.createBackgroundView([
      'runDueAmbientAiTasks',
    ])
    expect(activeLeaf).toBe(originalLeaf)
    setActiveLeaf.mockClear()
    activeLeaf = userSelectedLeaf

    session?.close()

    expect(backgroundLeaf.detach).toHaveBeenCalledTimes(1)
    expect(setActiveLeaf).not.toHaveBeenCalled()
    expect(activeLeaf).toBe(userSelectedLeaf)
  })

  test('closes an unusable background leaf', async () => {
    const backgroundLeaf: MockLeaf = {
      view: { getViewType: () => VIEW_TYPE_TASKCHUTE },
      setViewState: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn(),
    }
    const plugin = {
      app: {
        workspace: {
          getMostRecentLeaf: jest.fn(() => null),
          getLeaf: jest.fn(() => backgroundLeaf),
          revealLeaf: jest.fn(async () => undefined),
        },
      },
      _log: jest.fn(),
    } as unknown as TaskChutePluginLike

    const controller = new TaskChuteViewController(plugin)

    await expect(
      controller.createBackgroundView(['runDueAmbientAiTasks']),
    ).resolves.toBeNull()
    expect(backgroundLeaf.detach).toHaveBeenCalledTimes(1)
  })

  test('syncs newly started Ambient runs into open views except the background source', () => {
    const sourceSync = jest.fn()
    const visibleSync = jest.fn()
    const secondVisibleSync = jest.fn()
    const sourceView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      syncAmbientAiTaskRuns: sourceSync,
    }
    const visibleView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      syncAmbientAiTaskRuns: visibleSync,
    }
    const secondVisibleView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      syncAmbientAiTaskRuns: secondVisibleSync,
    }
    const plugin = createPlugin({
      activeLeaf: { view: visibleView },
      taskChuteLeaves: [
        { view: sourceView },
        { view: visibleView },
        // A duplicated leaf reference must not cause a second fan-out.
        { view: visibleView },
        { view: secondVisibleView },
        { view: { getViewType: () => 'markdown' } },
      ],
    })
    const controller = new TaskChuteViewController(plugin)

    controller.syncAmbientAiTaskRuns(
      sourceView as never,
      [STARTED_RUN],
      '2026-07-15',
    )

    expect(sourceSync).not.toHaveBeenCalled()
    expect(visibleSync).toHaveBeenCalledTimes(1)
    expect(visibleSync).toHaveBeenCalledWith(
      [STARTED_RUN],
      '2026-07-15',
    )
    expect(secondVisibleSync).toHaveBeenCalledTimes(1)
  })

  test('isolates an open-view sync failure and continues to later views', () => {
    const error = new Error('stale view')
    const failingSync = jest.fn(() => {
      throw error
    })
    const healthySync = jest.fn()
    const sourceView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      syncAmbientAiTaskRuns: jest.fn(),
    }
    const plugin = createPlugin({
      activeLeaf: null,
      taskChuteLeaves: [
        { view: sourceView },
        {
          view: {
            getViewType: () => VIEW_TYPE_TASKCHUTE,
            syncAmbientAiTaskRuns: failingSync,
          },
        },
        {
          view: {
            getViewType: () => VIEW_TYPE_TASKCHUTE,
            syncAmbientAiTaskRuns: healthySync,
          },
        },
      ],
    })
    plugin._log = jest.fn()
    const controller = new TaskChuteViewController(plugin)

    expect(() =>
      controller.syncAmbientAiTaskRuns(
        sourceView as never,
        [STARTED_RUN],
        '2026-07-15',
      ),
    ).not.toThrow()
    expect(healthySync).toHaveBeenCalledTimes(1)
    expect(plugin._log).toHaveBeenCalledWith(
      'warn',
      '[TaskChute] Failed to sync Ambient run into an open view',
      error,
    )
  })

  test('does not enumerate views when there are no newly started run snapshots', () => {
    const plugin = createPlugin({ activeLeaf: null, taskChuteLeaves: [] })
    const controller = new TaskChuteViewController(plugin)
    const sourceView = {
      getViewType: () => VIEW_TYPE_TASKCHUTE,
      syncAmbientAiTaskRuns: jest.fn(),
    }

    controller.syncAmbientAiTaskRuns(sourceView as never, [], '2026-07-15')

    expect(plugin.app.workspace.getLeavesOfType).not.toHaveBeenCalled()
  })
})
