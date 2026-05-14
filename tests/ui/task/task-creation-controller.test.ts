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

type TimeoutWindow = Window & {
  setTimeout: jest.Mock<number, [TimerHandler, number?]>
  clearTimeout: jest.Mock<void, [number]>
}

const setActiveWindow = (win: Window): void => {
  ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow = win
}

const createTimeoutWindow = (timeoutId: number): TimeoutWindow => (
  {
    setTimeout: jest.fn(() => timeoutId),
    clearTimeout: jest.fn(),
  } as unknown as TimeoutWindow
)

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

  const createHost = (settings: Partial<TaskChutePluginLike['settings']> = {}) => {
    const createdFile = new (TFile)()
    createdFile.path = 'TASKS/New Task.md'

    const taskCreationService = {
      createTaskFile: jest.fn().mockResolvedValue(createdFile),
    }

    const pluginStub: TaskChutePluginLike = {
      app: {} as App,
      settings: {
        useOrderBasedSort: true,
        slotKeys: {},
        ...settings,
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
      reuseTaskAtDate: jest.fn().mockResolvedValue({
        file: new (TFile)(),
        instanceId: 'reuse-instance-1',
      }),
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
      duplicateInstanceForPath: jest.fn().mockResolvedValue({
        path: 'TaskChute/Task/sample.md',
        instanceId: 'dup-instance-1',
      }),
      invalidateDayStateCache: jest.fn(),
      getDocumentContext: undefined,
      findDeletedTaskRestoreCandidate: jest.fn(() => null),
      restoreDeletedTaskCandidate: jest.fn().mockResolvedValue(true),
      openGoogleCalendarExportForCreatedTask: jest.fn(),
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

  test('showAddTaskModal does not render advanced settings when disabled', () => {
    const { host } = createHost()
    const controller = new TaskCreationController(host)

    controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement

    expect(modal.querySelector('.task-creation-advanced')).toBeNull()
  })

  test('showAddTaskModal saves advanced schedule options and opens calendar export', async () => {
    const { host, taskCreationService } = createHost({
      showTaskCreationAdvancedSettings: true,
      defaultReminderMinutes: 5,
      googleCalendar: {
        enabled: true,
        defaultDurationMinutes: 60,
        includeNoteContent: true,
      },
    })
    const controller = new TaskCreationController(host)

    controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    const scheduledInput = modal.querySelector('.task-creation-scheduled-time') as HTMLInputElement
    const reminderRow = modal.querySelector('.task-creation-reminder-row') as HTMLElement
    const calendarRow = modal.querySelector('.task-creation-calendar-row') as HTMLElement
    const reminderToggle = modal.querySelector('.task-creation-reminder-toggle') as HTMLInputElement
    const calendarToggle = modal.querySelector('.task-creation-calendar-toggle') as HTMLInputElement
    const form = modal.querySelector('form') as HTMLFormElement

    expect(reminderRow.classList.contains('hidden')).toBe(true)
    expect(calendarRow.classList.contains('hidden')).toBe(true)
    expect(modal.textContent).toContain('Start time:')
    expect(modal.textContent).toContain('Set reminder:')
    expect(modal.textContent).toContain('Register to calendar:')
    expect(modal.textContent).not.toContain('Enter a start time to enable reminder')
    expect(modal.textContent).not.toContain('Open the registration window after saving')

    nameInput.value = 'New Task'
    scheduledInput.value = '09:00'
    scheduledInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(reminderRow.classList.contains('hidden')).toBe(false)
    expect(calendarRow.classList.contains('hidden')).toBe(false)
    reminderToggle.checked = true
    reminderToggle.dispatchEvent(new Event('change', { bubbles: true }))
    calendarToggle.checked = true

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'New Task',
      '2025-10-09',
      '09:00',
      { reminderTime: '08:55' },
    )
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
    expect(host.openGoogleCalendarExportForCreatedTask).toHaveBeenCalledWith({
      path: 'TASKS/New Task.md',
    })
  })

  test('showAddTaskModal keeps advanced settings visible after autocomplete selection', () => {
    const { host } = createHost({
      showTaskCreationAdvancedSettings: true,
    })
    const controller = new TaskCreationController(host)

    controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement
    const input = modal.querySelector('input.form-input') as HTMLInputElement
    const advanced = modal.querySelector('.task-creation-advanced') as HTMLElement

    input.value = 'Existing Task'
    input.dispatchEvent(new CustomEvent('autocomplete-selected', {
      detail: {
        value: 'Existing Task',
        suggestion: {
          type: 'task',
          name: 'Existing Task',
          path: 'TaskChute/Task/existing.md',
        },
      },
    }))

    const modeGroup = modal.querySelector('.task-mode-group') as HTMLElement
    expect(modeGroup.classList.contains('hidden')).toBe(false)
    expect(advanced).not.toBeNull()
    expect(advanced.classList.contains('hidden')).toBe(false)
  })

  test('reuseExistingTask records duplicate via reuse service and invalidates cache', async () => {
    const { host } = createHost()
    host.hasInstanceForPathToday = jest.fn(() => false)
    const controller = new TaskCreationController(host)

    const result = await (controller as unknown as { reuseExistingTask: (path: string) => Promise<boolean> }).reuseExistingTask('TaskChute/Task/sample.md')

    expect(result).toBe(true)
    expect(host.taskReuseService.reuseTaskAtDate).toHaveBeenCalledWith('TaskChute/Task/sample.md', '2025-10-09', undefined)
    expect(host.invalidateDayStateCache).toHaveBeenCalledWith('2025-10-09')
    expect(host.duplicateInstanceForPath).not.toHaveBeenCalled()
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
  })

  test('showAddTaskModal applies advanced schedule options when reusing existing task', async () => {
    const { host } = createHost({
      showTaskCreationAdvancedSettings: true,
      defaultReminderMinutes: 5,
      googleCalendar: {
        enabled: true,
        defaultDurationMinutes: 60,
        includeNoteContent: true,
      },
    })
    host.hasInstanceForPathToday = jest.fn(() => false)
    const controller = new TaskCreationController(host)

    controller.showAddTaskModal()
    const modal = document.querySelector('.task-modal-overlay') as HTMLElement
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    const scheduledInput = modal.querySelector('.task-creation-scheduled-time') as HTMLInputElement
    const reminderToggle = modal.querySelector('.task-creation-reminder-toggle') as HTMLInputElement
    const calendarToggle = modal.querySelector('.task-creation-calendar-toggle') as HTMLInputElement
    const form = modal.querySelector('form') as HTMLFormElement

    nameInput.value = 'Existing Task'
    nameInput.dispatchEvent(new CustomEvent('autocomplete-selected', {
      detail: {
        value: 'Existing Task',
        suggestion: {
          type: 'task',
          name: 'Existing Task',
          path: 'TaskChute/Task/existing.md',
        },
      },
    }))
    scheduledInput.value = '09:00'
    scheduledInput.dispatchEvent(new Event('input', { bubbles: true }))
    reminderToggle.checked = true
    calendarToggle.checked = true

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(host.taskReuseService.reuseTaskAtDate).toHaveBeenCalledWith(
      'TaskChute/Task/existing.md',
      '2025-10-09',
      {
        scheduledTime: '09:00',
        reminderTime: '08:55',
      },
    )
    expect(host.openGoogleCalendarExportForCreatedTask).toHaveBeenCalledWith({
      path: 'TaskChute/Task/existing.md',
      instanceId: 'reuse-instance-1',
    })
  })

  test('reuseExistingTask duplicates locally when already visible', async () => {
    const { host } = createHost()
    host.hasInstanceForPathToday = jest.fn(() => true)
    const controller = new TaskCreationController(host)

    const result = await (controller as unknown as { reuseExistingTask: (path: string) => Promise<boolean> }).reuseExistingTask('TaskChute/Task/sample.md')

    expect(result).toBe(true)
    expect(host.duplicateInstanceForPath).toHaveBeenCalledWith('TaskChute/Task/sample.md', undefined)
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

  test('task name validation clears pending timer on the same Window that created it', () => {
    const originalActiveWindow = activeWindow
    const { host } = createHost()
    const sourceWindow = createTimeoutWindow(123)
    const focusedWindow = createTimeoutWindow(456)
    const controller = new TaskCreationController(host)
    const input = document.createElement('input')
    const submitButton = document.createElement('button')
    const warningElement = document.createElement('div')
    const validation = (controller as unknown as {
      setupTaskNameValidation: (
        inputElement: HTMLInputElement,
        submitButton: HTMLButtonElement,
        warningElement: HTMLElement,
      ) => { dispose: () => void }
    }).setupTaskNameValidation(input, submitButton, warningElement)

    try {
      setActiveWindow(sourceWindow)
      input.dispatchEvent(new Event('input'))

      setActiveWindow(focusedWindow)
      validation.dispose()

      expect(sourceWindow.setTimeout).toHaveBeenCalledWith(expect.any(Function), 150)
      expect(sourceWindow.clearTimeout).toHaveBeenCalledWith(123)
      expect(focusedWindow.clearTimeout).not.toHaveBeenCalled()
    } finally {
      setActiveWindow(originalActiveWindow)
    }
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
