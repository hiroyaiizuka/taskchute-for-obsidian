import TaskItemActionController, {
  type TaskItemActionHost,
} from '../../../src/ui/tasklist/TaskItemActionController'
import type { TaskInstance } from '../../../src/types'

const ensureCreateEl = () => {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: (
      tag: string,
      options?: { cls?: string; text?: string; attr?: Record<string, string> }
    ) => HTMLElement
  }
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options = {}) {
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
      ;(element as HTMLElement & { createEl?: typeof proto.createEl }).createEl = proto.createEl
      this.appendChild(element)
      return element
    }
  }
  const svgProto = (HTMLElement.prototype as unknown as { createSvg?: typeof document.createElementNS }).createSvg
  if (!svgProto) {
    ;(HTMLElement.prototype as unknown as { createSvg?: typeof document.createElementNS }).createSvg = function (
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
    }
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

const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => ({
  instanceId: 'instance-1',
  state: 'done',
  task: {
    path: 'TASKS/sample.md',
    projectPath: 'PROJECTS/sample.md',
    projectTitle: 'Project - Sample',
    isRoutine: false,
  },
  ...overrides,
}) as TaskInstance

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
    } as TaskInstance)

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
    button.click()
    expect(host.showTaskCompletionModal).toHaveBeenCalledWith(inst)
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

  test('renderRoutineButton toggles depending on routine flag', () => {
    const container = document.createElement('div')
    const { host } = createHost()
    const controller = new TaskItemActionController(host)
    const routineInstance = createInstance({ task: { path: 'TASKS/rt.md', isRoutine: true } })

    controller.renderRoutineButton(container, routineInstance)
    const routineButton = container.querySelector('.routine-button') as HTMLButtonElement
    expect(routineButton?.classList.contains('active')).toBe(true)
    routineButton?.click()
    expect(host.showRoutineEditModal).toHaveBeenCalledWith(routineInstance.task, routineButton)

    const nonRoutineContainer = document.createElement('div')
    controller.renderRoutineButton(nonRoutineContainer, createInstance({ task: { path: 'TASKS/nr.md', isRoutine: false } }))
    const nonRoutineButton = nonRoutineContainer.querySelector('.routine-button') as HTMLButtonElement
    nonRoutineButton?.click()
    expect(host.toggleRoutine).toHaveBeenCalled()
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

