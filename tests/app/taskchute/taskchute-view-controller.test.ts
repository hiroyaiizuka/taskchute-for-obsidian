import { TaskChuteViewController } from '../../../src/app/taskchute/TaskChuteViewController'
import { VIEW_TYPE_TASKCHUTE } from '../../../src/types'

import type { TaskChutePluginLike } from '../../../src/types'

type MockLeaf = {
  view?: {
    getViewType?: () => string
  }
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
