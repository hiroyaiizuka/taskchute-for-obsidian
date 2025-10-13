import TaskHeaderController, {
  TaskHeaderControllerHost,
  TaskHeaderControllerDependencies,
} from '../../../src/ui/header/TaskHeaderController'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

jest.mock('../../../src/i18n', () => {
  const actual = jest.requireActual('../../../src/i18n')
  return {
    ...actual,
    getCurrentLocale: () => 'en',
  }
})

describe('TaskHeaderController', () => {
  const attachCreateEl = (target: HTMLElement) => {
    const typed = target as HTMLElement & { createEl?: typeof attachCreateEl }
    typed.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const el = document.createElement(tag)
      if (options.cls) {
        el.className = options.cls as string
      }
      if (options.text) {
        el.textContent = options.text as string
      }
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          el.setAttribute(key, value)
        })
      }
      attachCreateEl(el)
      this.appendChild(el)
      return el
    }
  }

  const createHost = (overrides: Partial<TaskHeaderControllerHost> = {}): TaskHeaderControllerHost => {
    const registerManagedDomEvent = jest.fn((target: Document | HTMLElement, event: string, handler: EventListener) => {
      target.addEventListener(event, handler)
    })
    const plugin = {
      settings: {
        aiRobotButtonEnabled: overrides.plugin?.settings?.aiRobotButtonEnabled ?? false,
      },
    }
    const commands = overrides.app?.commands ?? {
      commands: { 'terminal:open-terminal.integrated.root': {} },
      executeCommandById: jest.fn(),
    }
    return {
      tv: (_key, fallback) => fallback,
      getCurrentDate: overrides.getCurrentDate ?? (() => new Date(2025, 9, 9)),
      setCurrentDate: overrides.setCurrentDate ?? jest.fn(),
      adjustCurrentDate: overrides.adjustCurrentDate ?? jest.fn(),
      reloadTasksAndRestore: overrides.reloadTasksAndRestore ?? jest.fn().mockResolvedValue(undefined),
      showAddTaskModal: overrides.showAddTaskModal ?? jest.fn(),
      toggleNavigation: overrides.toggleNavigation ?? jest.fn(),
      plugin: overrides.plugin ?? (plugin as unknown as TaskHeaderControllerHost['plugin']),
      app: overrides.app ?? ({ commands } as unknown as TaskHeaderControllerHost['app']),
      registerManagedDomEvent,
    }
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    jest.clearAllMocks()
  })

  test('render wires drawer and navigation arrows', async () => {
    const toggleNavigation = jest.fn()
    const adjustCurrentDate = jest.fn()
    const host = createHost({ toggleNavigation, adjustCurrentDate })
    const controller = new TaskHeaderController(host)
    const container = document.createElement('div')
    attachCreateEl(container)

    controller.render(container)

    const drawer = container.querySelector('.drawer-toggle') as HTMLButtonElement
    expect(drawer).toBeTruthy()
    drawer.dispatchEvent(new Event('click'))
    expect(toggleNavigation).toHaveBeenCalled()

    const arrows = container.querySelectorAll('.date-nav-arrow')
    expect(arrows).toHaveLength(2)
    arrows[0].dispatchEvent(new Event('click'))
    expect(adjustCurrentDate).toHaveBeenCalledWith(-1)
    arrows[1].dispatchEvent(new Event('click'))
    expect(adjustCurrentDate).toHaveBeenCalledWith(1)
  })

  test('render action buttons trigger add modal and robot command', async () => {
    const executeCommand = jest.fn().mockResolvedValue(undefined)
    const host = createHost({
      plugin: { settings: { aiRobotButtonEnabled: true } } as TaskHeaderControllerHost['plugin'],
      app: {
        commands: {
          commands: { 'terminal:open-terminal.integrated.root': {} },
          executeCommandById: executeCommand,
        },
      },
    })
    const controller = new TaskHeaderController(host)
    const container = document.createElement('div')
    attachCreateEl(container)

    controller.render(container)
    const addButton = container.querySelector('.add-task-button') as HTMLButtonElement
    addButton.dispatchEvent(new Event('click', { bubbles: true }))
    expect(host.showAddTaskModal).toHaveBeenCalled()

    const robotButton = container.querySelector('.robot-terminal-button') as HTMLButtonElement
    robotButton.dispatchEvent(new Event('click', { bubbles: true }))
    expect(executeCommand).toHaveBeenCalledWith('terminal:open-terminal.integrated.root')
  })

  test('calendar selection updates current date and triggers reload', async () => {
    const setCurrentDate = jest.fn()
    const reloadSpy = jest.fn().mockResolvedValue(undefined)
    const host = createHost({ setCurrentDate, reloadTasksAndRestore: reloadSpy })
    let capturedSelect: ((isoDate: string) => Promise<void> | void) | null = null
    let capturedClose: (() => void) | null = null
    const dependencies: TaskHeaderControllerDependencies = {
      createCalendar: (options) => {
        capturedSelect = options.onSelect
        capturedClose = options.onClose ?? null
        return {
          open: jest.fn(),
          close: jest.fn(),
        }
      },
    }
    const controller = new TaskHeaderController(host, dependencies)
    const container = document.createElement('div')
    attachCreateEl(container)

    controller.render(container)
    const calendarButton = container.querySelector('.calendar-btn') as HTMLButtonElement
    calendarButton.dispatchEvent(new Event('click'))

    expect(capturedSelect).toBeTruthy()
    await capturedSelect?.('2025-10-11')
    expect(setCurrentDate).toHaveBeenCalled()
    expect(reloadSpy).toHaveBeenCalled()

    capturedClose?.()
  })
})
