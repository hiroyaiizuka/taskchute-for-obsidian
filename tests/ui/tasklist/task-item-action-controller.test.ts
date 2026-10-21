import TaskItemActionController, {
  type TaskItemActionHost,
} from '@/ui/tasklist/TaskItemActionController'
import type { TaskData, TaskInstance } from '@/types'

/** Test overrides may supply a partial task; the runtime shape stays as written. */
type InstanceOverrides = Omit<Partial<TaskInstance>, 'task'> & {
  task?: Partial<TaskData>
}


const ensureCreateEl = () => {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: (
      tag: string,
      options?: { cls?: string; text?: string; attr?: Record<string, string> }
    ) => HTMLElement
  }
  if (!proto.createEl) {
    const createEl = function (
      this: HTMLElement,
      tag: string,
      options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
    ) {
      const element = document.createElement(tag)
      if (options.cls) {
        element.classList.add(...options.cls.split(' ').filter(Boolean))
      }
      if (options.text !== undefined) {
        element.textContent = options.text
      }
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          if (value !== undefined) {
            element.setAttribute(key, value)
          }
        })
      }
      element.createEl = createEl as unknown as HTMLElement['createEl']
      this.appendChild(element)
      return element
    }
    proto.createEl = createEl
  }
  if (!HTMLElement.prototype.createSvg) {
    HTMLElement.prototype.createSvg = (function (
      this: HTMLElement,
      tag: string,
      options: { attr?: Record<string, string>; cls?: string } = {},
    ) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', tag)
      if (options.cls) svg.setAttribute('class', options.cls)
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => svg.setAttribute(key, value))
      }
      this.appendChild(svg as unknown as HTMLElement)
      return svg
    }) as unknown as HTMLElement['createSvg']
  }
}

const flushAsync = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const createHost = (overrides: Partial<TaskItemActionHost> = {}) => {
  const registerManagedDomEvent = jest.fn((target: HTMLElement | Document, event: string, handler: EventListener) => {
    target.addEventListener(event, handler)
  })

  const base: TaskItemActionHost = {
    tv: (_key, fallback) => fallback,
    app: {
      workspace: {
        openLinkText: jest.fn(),
      },
    },
    registerManagedDomEvent,
    showTaskCompletionModal: jest.fn(),
    hasCommentData: jest.fn(async () => false),
    showRoutineEditModal: jest.fn(),
    toggleRoutine: jest.fn(),
    showTaskSettingsTooltip: jest.fn(),
    showProjectModal: jest.fn(),
    showUnifiedProjectModal: jest.fn(),
    openProjectInSplit: jest.fn(),
    ...overrides,
  }

  return { host: base, registerManagedDomEvent }
}

const createInstance = (overrides: InstanceOverrides = {}): TaskInstance => ({
  instanceId: 'instance-1',
  state: 'done',
  task: {
    path: 'TASKS/sample.md',
    projectPath: 'PROJECTS/sample.md',
    projectTitle: 'Project - Sample',
    isRoutine: false,
  },
  ...overrides,
}) as unknown as TaskInstance

describe('TaskItemActionController', () => {
  beforeAll(() => ensureCreateEl())

  beforeEach(() => {
    document.body.innerHTML = ''
    jest.clearAllMocks()
  })

  test('renderProject wires project button and external link', () => {
    const container = document.createElement('div')
    const { host } = createHost()
    const controller = new TaskItemActionController(host)
    const inst = createInstance()

    controller.renderProject(container, inst)

    const button = container.querySelector('.taskchute-project-button') as HTMLElement
    expect(button).toBeTruthy()
    button.dispatchEvent(new Event('click'))
    expect(host.showUnifiedProjectModal).toHaveBeenCalledWith(inst)

    const external = container.querySelector('.taskchute-external-link') as HTMLElement
    expect(external).toBeTruthy()
    external.dispatchEvent(new Event('click'))
    expect(host.openProjectInSplit).toHaveBeenCalledWith('PROJECTS/sample.md')
  })

  test('renderProject falls back to placeholder and opens modal', () => {
    const container = document.createElement('div')
    const { host } = createHost()
    const controller = new TaskItemActionController(host)
    const inst = createInstance({
      task: {
        path: 'TASKS/orphan.md',
        name: 'orphan',
        isRoutine: false,
      },
    })

    controller.renderProject(container, inst)

    const placeholder = container.querySelector('.taskchute-project-placeholder') as HTMLElement
    expect(placeholder?.textContent).toBe('Set project')
    placeholder?.dispatchEvent(new Event('click'))
    expect(host.showProjectModal).toHaveBeenCalledWith(inst)
  })

  test('renderCommentButton enables done tasks and triggers modal', async () => {
    const container = document.createElement('div')
    const { host } = createHost({ hasCommentData: jest.fn(async () => true) })
    const controller = new TaskItemActionController(host)
    const inst = createInstance({ state: 'done' })

    controller.renderCommentButton(container, inst)

    await flushAsync()

    const button = container.querySelector('.comment-button') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.classList.contains('active')).toBe(true)
    expect(button.classList.contains('no-comment')).toBe(false)
    button.click()
    expect(host.showTaskCompletionModal).toHaveBeenCalledWith(inst)
  })

  test("a done task's 💬 starts as an empty one, so the comment lookup does not fade it out (LEV-394)", async () => {
    const container = document.createElement('div')
    const { host } = createHost({ hasCommentData: jest.fn(async () => false) })
    const controller = new TaskItemActionController(host)

    controller.renderCommentButton(container, createInstance({ state: 'done' }))

    const button = container.querySelector('.comment-button') as HTMLButtonElement
    expect(button.classList.contains('no-comment')).toBe(true)
    await flushAsync()
    expect(button.classList.contains('no-comment')).toBe(true)
    expect(button.classList.contains('active')).toBe(false)
  })

  test('renderCommentButton keeps running tasks disabled', () => {
    const container = document.createElement('div')
    const { host } = createHost()
    const controller = new TaskItemActionController(host)
    const inst = createInstance({ state: 'running' })

    controller.renderCommentButton(container, inst)

    const button = container.querySelector('.comment-button') as HTMLButtonElement
    expect(button?.hasAttribute('disabled')).toBe(true)
    button?.click()
    expect(host.showTaskCompletionModal).not.toHaveBeenCalled()
  })

  test("a running task's 💬 carries no count, and is an empty one until the first comment", () => {
    const render = (state: { count: number; open: boolean }) => {
      const container = document.createElement('div')
      const { host } = createHost({ getRunningComments: () => state, toggleRunningComments: jest.fn() })
      const inst = createInstance({ state: 'running' })
      new TaskItemActionController(host).renderCommentButton(container, inst)
      const button = container.querySelector('.comment-button--running') as HTMLButtonElement
      return { button, host, inst }
    }

    const withComments = render({ count: 2, open: false })
    expect(withComments.button.textContent).toBe('💬')
    expect(withComments.button.classList.contains('active')).toBe(true)
    expect(withComments.button.classList.contains('no-comment')).toBe(false)
    withComments.button.click()
    expect(withComments.host.toggleRunningComments).toHaveBeenCalledWith(withComments.inst)

    const empty = render({ count: 0, open: false })
    expect(empty.button.classList.contains('no-comment')).toBe(true)
    expect(empty.button.classList.contains('active')).toBe(false)

    // Its panel open, the 💬 is what closes it: never an empty one then.
    const open = render({ count: 0, open: true })
    expect(open.button.classList.contains('no-comment')).toBe(false)
    expect(open.button.classList.contains('is-open')).toBe(true)
  })

  test('renderRoutineButton toggles depending on routine flag', async () => {
    jest.useFakeTimers()
    const container = document.createElement('div')
    const { host } = createHost()
    const controller = new TaskItemActionController(host)
    const routineInstance = createInstance({ task: { path: 'TASKS/rt.md', isRoutine: true } })

    controller.renderRoutineButton(container, routineInstance)
    const routineButton = container.querySelector('.routine-button') as HTMLButtonElement
    expect(routineButton?.classList.contains('active')).toBe(true)
    routineButton?.click()
    // The click handler has a 50ms delay for mobile touch event handling
    jest.advanceTimersByTime(50)
    expect(host.showRoutineEditModal).toHaveBeenCalledWith(routineInstance.task, routineButton)

    const nonRoutineContainer = document.createElement('div')
    controller.renderRoutineButton(nonRoutineContainer, createInstance({ task: { path: 'TASKS/nr.md', isRoutine: false } }))
    const nonRoutineButton = nonRoutineContainer.querySelector('.routine-button') as HTMLButtonElement
    nonRoutineButton?.click()
    expect(host.toggleRoutine).toHaveBeenCalled()
    jest.useRealTimers()
  })

  test('renderSettingsButton delegates to tooltip controller', () => {
    const container = document.createElement('div')
    const { host } = createHost()
    const controller = new TaskItemActionController(host)
    const inst = createInstance()

    controller.renderSettingsButton(container, inst)

    const button = container.querySelector('.settings-task-button') as HTMLButtonElement
    expect(button).toBeTruthy()
    button?.click()
    expect(host.showTaskSettingsTooltip).toHaveBeenCalledWith(inst, button)
  })
})

