import TaskRowController from '../../../src/ui/tasklist/TaskRowController'
import type { TaskInstance } from '../../../src/types'

type CreateElFn = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: {
    cls?: string
    text?: string
    attr?: Record<string, string>
  },
) => HTMLElementTagNameMap[K]

const addCreateEl = (element: HTMLElement): HTMLElement & { createEl: CreateElFn } => {
  const augmentedElement = element as HTMLElement & { createEl: CreateElFn };
  augmentedElement.createEl = (tag, options = {}) => {
    const child = document.createElement(tag)
    if (options.cls) {
      const classes = options.cls.split(' ').filter(c => c.length > 0)
      if (classes.length > 0) {
        child.classList.add(...classes)
      }
    }
    if (options.text) child.textContent = options.text
    if (options.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        child.setAttribute(key, value)
      })
    }
    element.appendChild(child)
    // Recursively add createEl to child elements
    return addCreateEl(child)
  }
  return augmentedElement
}

const createTaskElement = () => {
  const element = document.createElement('div')
  return addCreateEl(element)
}

describe('TaskRowController.renderTaskName', () => {
  const createHost = () => ({
    tv: (_key: string, fallback: string) => fallback,
    startInstance: jest.fn(),
    stopInstance: jest.fn(),
    duplicateAndStartInstance: jest.fn(),
    showTimeEditModal: jest.fn(),
    showReminderSettingsModal: jest.fn(),
    calculateCrossDayDuration: jest.fn(),
    app: {
      workspace: {
        openLinkText: jest.fn(),
      },
    },
  })

  it('prefers executedTitle for completed tasks', () => {
    const controller = new TaskRowController(createHost())
    const taskItem = createTaskElement()

    const instance = {
      task: {
        name: '現在のタスク名',
        displayTitle: '現在のタスク名',
        path: 'TASKS/routine.md',
      },
      state: 'done',
      executedTitle: '実行時のタスク名',
    } as unknown as TaskInstance

    controller.renderTaskName(taskItem, instance)

    const label = taskItem.querySelector('.task-name')
    expect(label?.textContent).toBe('実行時のタスク名')
  })

  it('falls back to displayTitle and name when executedTitle is absent', () => {
    const controller = new TaskRowController(createHost())
    const taskItem = createTaskElement()

    const instance = {
      task: {
        name: 'Fallback Name',
        displayTitle: 'Display Title',
        path: 'TASKS/sample.md',
      },
      state: 'idle',
    } as unknown as TaskInstance

    controller.renderTaskName(taskItem, instance)

    const label = taskItem.querySelector('.task-name')
    expect(label?.textContent).toBe('Display Title')
  })
})
