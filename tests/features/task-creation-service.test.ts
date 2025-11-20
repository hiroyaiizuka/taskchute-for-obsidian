import { Notice, TFile } from 'obsidian'
import { TaskCreationService } from '../../src/features/core/services/TaskCreationService'
import type { TaskChutePluginLike } from '../../src/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

describe('TaskCreationService', () => {
  const createPlugin = () => {
    const file = new TFile()
    file.path = 'TaskChute/Task/My Task.md'
    file.basename = 'My Task'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create: jest.fn().mockResolvedValue(file),
        },
      },
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as TaskChutePluginLike & { app: { vault: { getAbstractFileByPath: jest.Mock; create: jest.Mock } } }

    return plugin
  }

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
  })

  test('createTaskFile writes taskId into frontmatter', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '08:30')

    expect(plugin.app.vault.create).toHaveBeenCalledTimes(1)
    const content = plugin.app.vault.create.mock.calls[0]?.[1] as string
    expect(content).toContain('taskId: "tc-task-')
    expect(content).toContain('target_date: "2025-11-16"')
    expect(content).toContain('scheduled_time: "08:30"')
  })

  test('createTaskFile uses provided taskId when supplied', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', undefined, {
      taskId: 'tc-task-restore',
    })

    const lastCall = plugin.app.vault.create.mock.calls[plugin.app.vault.create.mock.calls.length - 1]
    const content = lastCall?.[1] as string
    expect(content).toContain('taskId: "tc-task-restore"')
  })
})
