import { Notice, TFile } from 'obsidian'
import TaskCreationController, {
  TaskCreationControllerHost,
  DeletedTaskRestoreCandidate,
} from '../../../src/ui/task/TaskCreationController'
import { TaskNameAutocomplete } from '../../../src/ui/components/TaskNameAutocomplete'
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
      createTaskFile: jest.fn().mockResolvedValue(new (TFile)()),
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

    const taskReuseService = {
      reuseTaskAtDate: jest.fn().mockResolvedValue(new (TFile)()),
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
      taskReuseService: taskReuseService as unknown as TaskCreationControllerHost['taskReuseService'],
      registerAutocompleteCleanup: jest.fn(),
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
      getCurrentDateString: () => '2025-10-09',
      app: {
        metadataCache: {
          getFileCache: jest.fn(() => ({ frontmatter: {} })),
        },
      },
      plugin: pluginStub,
      hasInstanceForPathToday: jest.fn(() => false),
      duplicateInstanceForPath: jest.fn().mockResolvedValue(true),
      invalidateDayStateCache: jest.fn(),
      getDocumentContext: undefined,
      findDeletedTaskRestoreCandidate: jest.fn(() => null),
      restoreDeletedTaskCandidate: jest.fn().mockResolvedValue(true),
    }

    return { host, taskCreationService, taskReuseService }
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    ;(Notice as unknown as jest.Mock).mockClear()
    ;(TaskNameAutocomplete as unknown as jest.Mock).mockClear()
  })

  test('showAddTaskModal creates task on submit', async () => {
    const { host, taskCreationService } = createHost()
    const controller = new TaskCreationController(host)

    controller.showAddTaskModal()
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

  test('reuseExistingTask records duplicate via reuse service and invalidates cache', async () => {
    const { host } = createHost()
    host.hasInstanceForPathToday = jest.fn(() => false)
    const controller = new TaskCreationController(host)

    const result = await (controller as unknown as { reuseExistingTask: (path: string) => Promise<boolean> }).reuseExistingTask('TaskChute/Task/sample.md')

    expect(result).toBe(true)
    expect(host.taskReuseService.reuseTaskAtDate).toHaveBeenCalledWith('TaskChute/Task/sample.md', '2025-10-09')
    expect(host.invalidateDayStateCache).toHaveBeenCalledWith('2025-10-09')
    expect(host.duplicateInstanceForPath).not.toHaveBeenCalled()
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
  })

  test('reuseExistingTask duplicates locally when already visible', async () => {
    const { host } = createHost()
    host.hasInstanceForPathToday = jest.fn(() => true)
    const controller = new TaskCreationController(host)

    const result = await (controller as unknown as { reuseExistingTask: (path: string) => Promise<boolean> }).reuseExistingTask('TaskChute/Task/sample.md')

    expect(result).toBe(true)
    expect(host.duplicateInstanceForPath).toHaveBeenCalledWith('TaskChute/Task/sample.md')
    expect(host.taskReuseService.reuseTaskAtDate).not.toHaveBeenCalled()
    expect(host.invalidateDayStateCache).not.toHaveBeenCalled()
  })

  test('showAddTaskModal injects host-provided document/window context', async () => {
    const { host } = createHost()
    const popoutDoc = document.implementation.createHTMLDocument('popout')
    const fakeWindow = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    } as unknown as Window & typeof globalThis
    host.getDocumentContext = () => ({ doc: popoutDoc, win: fakeWindow })

    const controller = new TaskCreationController(host)
    controller.showAddTaskModal()

    expect(popoutDoc.body.querySelector('.task-modal-overlay')).not.toBeNull()
    expect(document.body.querySelector('.task-modal-overlay')).toBeNull()

    const modeGroup = popoutDoc.querySelector('.task-mode-group')
    expect(modeGroup).not.toBeNull()
    expect(modeGroup?.ownerDocument).toBe(popoutDoc)

    const autocompleteMock = TaskNameAutocomplete as unknown as jest.Mock
    expect(autocompleteMock).toHaveBeenCalled()
    const ctorArgs = autocompleteMock.mock.calls[0]
    expect(ctorArgs[3]?.doc).toBe(popoutDoc)
    expect(ctorArgs[3]?.win).toBe(fakeWindow)
  })

  test('shows inline restore banner when deleted task candidate is found', async () => {
    const { host } = createHost()
    const candidate: DeletedTaskRestoreCandidate = {
      entry: { path: 'TaskChute/Task/Restore me.md', deletionType: 'permanent', taskId: 'tc-task-restore' },
      displayTitle: 'Restore me',
      fileExists: false,
    }
    host.findDeletedTaskRestoreCandidate = jest.fn((name: string) =>
      name.trim() === 'Restore me' ? candidate : null,
    )

    const controller = new TaskCreationController(host)
    controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement
    const input = modal.querySelector('input') as HTMLInputElement

    input.value = 'Restore me'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()

    const banner = modal.querySelector('.task-restore-banner') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.classList.contains('hidden')).toBe(false)
    expect(host.findDeletedTaskRestoreCandidate).toHaveBeenCalledWith('Restore me')

    const button = banner.querySelector('button') as HTMLButtonElement
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(host.restoreDeletedTaskCandidate).toHaveBeenCalledWith(candidate)
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
    expect(document.querySelector('.task-modal-overlay')).toBeNull()
  })

  test('hides restore banner when candidate disappears', async () => {
    const { host } = createHost()
    const candidate: DeletedTaskRestoreCandidate = {
      entry: { path: 'TaskChute/Task/Recover.md', deletionType: 'permanent' },
      displayTitle: 'Recover',
      fileExists: true,
    }
    host.findDeletedTaskRestoreCandidate = jest
      .fn()
      .mockImplementation((name: string) => (name.trim() === 'Recover' ? candidate : null))

    const controller = new TaskCreationController(host)
    controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement
    const input = modal.querySelector('input') as HTMLInputElement

    input.value = 'Recover'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
    const banner = modal.querySelector('.task-restore-banner') as HTMLElement
    expect(banner?.classList.contains('hidden')).toBe(false)

    input.value = 'Different'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()

    expect(banner.classList.contains('hidden')).toBe(true)
  })
})
