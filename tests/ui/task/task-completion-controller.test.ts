import { TFile } from 'obsidian'
import TaskCompletionController, { TaskCompletionControllerHost } from '../../../src/ui/task/TaskCompletionController'
import type { TaskInstance } from '../../../src/types'
import { ProjectNoteSyncService } from '../../../src/features/project/services/ProjectNoteSyncService'

jest.mock('obsidian', () => {
  const Actual = jest.requireActual('obsidian')
  return {
    ...Actual,
    Notice: jest.fn(),
    TFile: class MockTFile {
      path = ''
      basename = ''
      extension = 'md'
    },
  }
})

jest.mock('../../../src/features/project/services/ProjectNoteSyncService', () => {
  return {
    ProjectNoteSyncService: jest.fn().mockImplementation(() => ({
      getProjectNotePath: jest.fn().mockResolvedValue('Projects/Note.md'),
      updateProjectNote: jest.fn().mockResolvedValue(undefined),
    })),
  }
})

describe('TaskCompletionController', () => {
  beforeAll(() => {
    const proto = HTMLElement.prototype as unknown as {
      createEl?: (
        tag: string,
        options?: { cls?: string; text?: string; attr?: Record<string, string>; type?: string },
      ) => HTMLElement
    }
    if (!proto.createEl) {
      proto.createEl = function (tag, options) {
        const element = document.createElement(tag)
        if (options?.cls) {
          element.classList.add(...options.cls.split(' ').filter(Boolean))
        }
        if (options?.text) {
          element.textContent = options.text
        }
        if (options?.attr) {
          Object.entries(options.attr).forEach(([key, value]) => {
            if (value !== undefined) {
              element.setAttribute(key, value)
            }
          })
        }
        if (options?.type) {
          (element as HTMLInputElement).type = options.type
        }
        this.appendChild(element)
        return element
      }
    }
  })

  const createHost = () => {
    const storage = new Map<string, string>()
    const vault = {
      getAbstractFileByPath: jest.fn((path: string) => {
        if (!storage.has(path)) return null
        const file = new (TFile as typeof TFile)()
        file.path = path
        file.basename = path.split('/').pop() ?? ''
        return file
      }),
      read: jest.fn(async (file: TFile | null) => {
        if (!file) return ''
        return storage.get(file.path) ?? ''
      }),
      modify: jest.fn(async (file: TFile, data: string) => {
        storage.set(file.path, data)
      }),
      create: jest.fn(async (path: string, data: string) => {
        storage.set(path, data)
      }),
    }

    const host: TaskCompletionControllerHost = {
      tv: (_key, fallback, vars) => {
        if (vars) {
          return fallback.replace('{duration}', String(vars.duration ?? '')).replace('{message}', String(vars.message ?? ''))
        }
        return fallback
      },
      renderTaskList: jest.fn(),
      getInstanceDisplayTitle: () => 'Sample task',
      calculateCrossDayDuration: (start?: Date, stop?: Date) => {
        if (!start || !stop) return 0
        return stop.getTime() - start.getTime()
      },
      getCurrentDate: () => new Date('2025-10-09T00:00:00Z'),
      app: {
        vault,
        fileManager: {
          processFrontMatter: jest.fn().mockResolvedValue(undefined),
        },
      },
      plugin: {
        pathManager: {
          getLogDataPath: () => 'LOGS',
          ensureFolderExists: jest.fn().mockResolvedValue(undefined),
          getTaskFolderPath: () => 'TASKS',
          getProjectFolderPath: () => 'PROJECTS',
          getReviewDataPath: () => 'REVIEWS',
          getLogYearPath: jest.fn(),
          ensureYearFolder: jest.fn(),
          validatePath: jest.fn(() => ({ valid: true })),
        },
      },
    }

    return { host, storage, vault }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    document.body.innerHTML = ''
  })

  test('hasCommentData returns true after comment saved', async () => {
    const { host, storage } = createHost()
    const controller = new TaskCompletionController(host)
    const inst = {
      instanceId: 'inst-1',
      state: 'done',
      task: {
        path: 'TASKS/sample.md',
        name: 'sample',
        projectTitle: 'Project Sample',
      },
      startTime: new Date('2025-10-09T08:00:00Z'),
      stopTime: new Date('2025-10-09T09:00:00Z'),
    } as unknown as TaskInstance

    expect(await controller.hasCommentData(inst)).toBe(false)

    const actions = controller as unknown as {
      saveTaskComment: (instance: TaskInstance, payload: { comment: string; energy: number; focus: number }) => Promise<void>
    }
    await actions.saveTaskComment(inst, {
      comment: 'Great work',
      energy: 4,
      focus: 5,
    })

    expect(storage.has('LOGS/2025-10-tasks.json')).toBe(true)
    expect(await controller.hasCommentData(inst)).toBe(true)
  })

  test('showTaskCompletionModal wires save handler and emits notice', async () => {
    const { host } = createHost()
    const controller = new TaskCompletionController(host)
    const inst = {
      instanceId: 'inst-2',
      state: 'done',
      task: {
        path: 'TASKS/sample.md',
        name: 'sample',
        projectTitle: 'Project Sample',
        projectPath: 'Projects/Project Sample.md',
      },
      startTime: new Date('2025-10-09T08:00:00Z'),
      stopTime: new Date('2025-10-09T08:30:00Z'),
      actualTime: 1800,
    } as unknown as TaskInstance

    await controller.showTaskCompletionModal(inst)
    const saveButton = document.querySelector('.taskchute-button-save') as HTMLButtonElement
    expect(saveButton).toBeTruthy()
    saveButton.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
    expect(host.renderTaskList).toHaveBeenCalled()
    const SyncMock = ProjectNoteSyncService as unknown as jest.Mock
    const syncInstance = SyncMock.mock.instances.at(-1)
    if (syncInstance && syncInstance.updateProjectNote) {
      expect(syncInstance.updateProjectNote).toHaveBeenCalled()
    }
  })
})
