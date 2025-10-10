import { Notice, TFile } from 'obsidian'
import TaskCreationController, { TaskCreationControllerHost } from '../../../src/ui/task/TaskCreationController'
import type { TaskNameValidator, TaskChutePluginLike } from '../../../src/types'
import type { App } from 'obsidian'

jest.mock('obsidian', () => {
  const Actual = jest.requireActual('obsidian')
  return {
    ...Actual,
    Notice: jest.fn(),
    TFile: class MockTFile {},
  }
})

jest.mock('../../../src/ui/components/TaskNameAutocomplete', () => ({
  TaskNameAutocomplete: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(),
    isSuggestionsVisible: jest.fn(() => false),
    hasActiveSelection: jest.fn(() => false),
  })),
}))

describe('TaskCreationController', () => {
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

  const validator: TaskNameValidator = {
    INVALID_CHARS_PATTERN: /[\\/:]/g,
    validate: (name: string) => {
      const invalidChars = name.match(/[\\/:]/g) ?? []
      return {
        isValid: invalidChars.length === 0 && name.trim().length > 0,
        invalidChars,
      }
    },
    getErrorMessage: (chars: string[]) => `Invalid: ${chars.join(',')}`,
  }

  const createHost = () => {
    const taskCreationService = {
      createTaskFile: jest.fn().mockResolvedValue(new (TFile as typeof TFile)()),
    }

    const pluginStub: TaskChutePluginLike = {
      app: {} as App,
      settings: {
        useOrderBasedSort: true,
        slotKeys: {},
      },
      pathManager: {
        getTaskFolderPath: () => 'TASKS',
        getProjectFolderPath: () => 'PROJECTS',
        getLogDataPath: () => 'LOGS',
        getReviewDataPath: () => 'REVIEWS',
        ensureFolderExists: jest.fn(),
        getLogYearPath: jest.fn(),
        ensureYearFolder: jest.fn(),
        validatePath: jest.fn(() => ({ valid: true })),
      },
      routineAliasService: {
        loadAliases: jest.fn(),
      },
      dayStateService: {
        loadDay: jest.fn(),
        saveDay: jest.fn(),
        mergeDayState: jest.fn(),
        clearCache: jest.fn(),
        getDateFromKey: jest.fn(),
      },
      saveSettings: jest.fn(),
      manifest: { id: 'taskchute-plus' },
    }

    const host: TaskCreationControllerHost = {
      tv: (_key, fallback, vars) => {
        if (vars) {
          const entries = Object.entries(vars)
          if (entries.length > 0) {
            return `${fallback} ${entries.map(([k, v]) => `${k}:${v}`).join('')}`
          }
        }
        return fallback
      },
      getTaskNameValidator: () => validator,
      taskCreationService: taskCreationService as unknown as TaskCreationControllerHost['taskCreationService'],
      registerAutocompleteCleanup: jest.fn(),
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
      getCurrentDateString: () => '2025-10-09',
      app: {
        metadataCache: {
          getFileCache: jest.fn(() => ({ frontmatter: {} })),
        },
      },
      plugin: pluginStub,
    }

    return { host, taskCreationService }
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    ;(Notice as unknown as jest.Mock).mockClear()
  })

  test('showAddTaskModal creates task on submit', async () => {
    const { host, taskCreationService } = createHost()
    const controller = new TaskCreationController(host)

    await controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement
    expect(modal).toBeTruthy()

    const input = modal.querySelector('input') as HTMLInputElement
    const form = modal.querySelector('form') as HTMLFormElement
    input.value = 'New Task'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith('New Task', '2025-10-09')
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
    expect(document.querySelector('.task-modal-overlay')).toBeNull()
  })
})
