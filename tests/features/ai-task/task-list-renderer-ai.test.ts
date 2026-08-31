import TaskListRenderer, {
  TaskListRendererHost,
} from '../../../src/ui/tasklist/TaskListRenderer'
import type { TaskInstance } from '../../../src/types'

// JSDOM lacks DragEvent; provide a minimal polyfill
if (typeof globalThis.DragEvent === 'undefined') {
  ;(globalThis as Record<string, unknown>).DragEvent = class DragEvent extends Event {
    readonly dataTransfer: DataTransfer | null
    constructor(
      type: string,
      init?: EventInit & { dataTransfer?: DataTransfer | null },
    ) {
      super(type, init)
      this.dataTransfer = init?.dataTransfer ?? null
    }
  }
}

function createBaseHost(instances: TaskInstance[]): TaskListRendererHost {
  const taskList = document.body.createDiv({ cls: 'task-list' })
  return {
    taskList,
    taskInstances: instances,
    currentDate: new Date(2026, 0, 1),
    tv: (_key: string, fallback: string) => fallback,
    app: {
      workspace: {
        openLinkText: jest.fn(),
      },
    },
    sortTaskInstancesByTimeOrder: jest.fn(),
    getTimeSlotKeys: () => ['0:00-8:00', '8:00-12:00', '12:00-16:00', '16:00-0:00'],
    sortByOrder: (items: TaskInstance[]) => [...items],
    selectTaskForKeyboard: jest.fn(),
    registerManagedDomEvent: jest.fn(
      (target: HTMLElement | Document, event: string, handler: EventListener) => {
        target.addEventListener(event, handler)
      },
    ),
    handleDragOver: jest.fn(),
    handleDrop: jest.fn(),
    handleSlotDrop: jest.fn(),
    startInstance: jest.fn(),
    stopInstance: jest.fn(),
    duplicateAndStartInstance: jest.fn(),
    showTaskCompletionModal: jest.fn(),
    hasCommentData: jest.fn(async () => false),
    showRoutineEditModal: jest.fn(),
    toggleRoutine: jest.fn(),
    showTaskSettingsTooltip: jest.fn(),
    showTaskContextMenu: jest.fn(),
    calculateCrossDayDuration: (start: Date, stop: Date) =>
      stop.getTime() - start.getTime(),
    showStartTimePopup: jest.fn(),
    showStopTimePopup: jest.fn(),
    showReminderSettingsModal: jest.fn(),
    isCollapsibleEnabled: () => false,
    updateTotalTasksCount: jest.fn(),
  }
}

function createAiInstance(): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: { ai_task: true },
      path: 'TASKS/ai-sample.md',
      name: 'AI sample',
      isRoutine: false,
    },
    instanceId: 'ai-instance-1',
    state: 'idle',
    slotKey: 'none',
  }
}

describe('TaskListRenderer AI task integration', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  test('does not render AI controls when the host lacks AI members', () => {
    const host = createBaseHost([createAiInstance()])
    new TaskListRenderer(host).render()

    expect(host.taskList.querySelector('.ai-task-edit-button')).toBeNull()
  })

  test('renders the AI controls inside the task name container, not as a task item column', () => {
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => true
    host.editAiTask = jest.fn()

    new TaskListRenderer(host).render()

    const taskItem = host.taskList.querySelector('.task-item') as HTMLElement
    const button = taskItem.querySelector('.ai-task-edit-button')
    expect(button).not.toBeNull()

    // The .task-item grid uses a fixed column template, so the AI controls
    // must not become a direct child (extra grid cell) of the row. They live
    // inside .task-name-container, like the reminder and recipe icons.
    const controls = taskItem.querySelector('.ai-task-controls')
    expect(controls).not.toBeNull()
    expect(
      controls?.parentElement?.classList.contains('task-name-container'),
    ).toBe(true)
    expect(
      Array.from(taskItem.children).some((el) =>
        el.classList.contains('ai-task-controls'),
      ),
    ).toBe(false)
  })

  test('clicking the robot opens AI task settings without selecting the row', () => {
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => true
    host.editAiTask = jest.fn()

    new TaskListRenderer(host).render()

    const button = host.taskList.querySelector<HTMLButtonElement>(
      '.ai-task-edit-button',
    )
    button?.click()

    expect(host.editAiTask).toHaveBeenCalledTimes(1)
    expect(host.selectTaskForKeyboard).not.toHaveBeenCalled()
  })

  test('keeps the plain robot button and omits redundant status for a running task', () => {
    const running = createAiInstance()
    running.state = 'running'
    const host = createBaseHost([running])
    host.isAiTaskFeatureEnabled = () => true
    host.editAiTask = jest.fn()

    new TaskListRenderer(host).render()

    const button = host.taskList.querySelector<HTMLButtonElement>(
      '.ai-task-edit-button',
    )
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('🤖')
    expect(host.taskList.querySelector('.ai-task-status-chip')).toBeNull()

    button?.click()
    expect(host.editAiTask).toHaveBeenCalledTimes(1)
  })

  test('duplicated idle and running rows both keep the same robot button', () => {
    const first = createAiInstance()
    const second = {
      ...createAiInstance(),
      instanceId: 'ai-instance-2',
      state: 'running',
    } as TaskInstance
    const host = createBaseHost([first, second])
    host.isAiTaskFeatureEnabled = () => true
    host.editAiTask = jest.fn()

    new TaskListRenderer(host).render()

    const items = Array.from(
      host.taskList.querySelectorAll<HTMLElement>('.task-item'),
    )
    expect(items).toHaveLength(2)
    expect(items[0].querySelector('.ai-task-status-chip')).toBeNull()
    expect(
      items[0].querySelector('.ai-task-edit-button'),
    ).not.toBeNull()
    expect(items[1].querySelector('.ai-task-status-chip')).toBeNull()
    expect(
      items[1].querySelector('.ai-task-edit-button'),
    ).not.toBeNull()
  })

  test('does not render AI controls when the feature toggle reports disabled', () => {
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => false
    host.editAiTask = jest.fn()

    new TaskListRenderer(host).render()

    expect(host.taskList.querySelector('.ai-task-edit-button')).toBeNull()
    expect(host.taskList.querySelector('.ai-task-status-chip')).toBeNull()
  })

  test('does not render AI controls for tasks without ai_task frontmatter', () => {
    const plain: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/plain.md',
        name: 'Plain task',
        isRoutine: false,
      },
      instanceId: 'plain-1',
      state: 'idle',
      slotKey: 'none',
    }
    const host = createBaseHost([plain])
    host.isAiTaskFeatureEnabled = () => true
    host.editAiTask = jest.fn()

    new TaskListRenderer(host).render()

    expect(host.taskList.querySelector('.ai-task-edit-button')).toBeNull()
  })
})
