import TaskListRenderer, {
  TaskListRendererHost,
} from '../../../src/ui/tasklist/TaskListRenderer'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
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
    applyResponsiveClasses: jest.fn(),
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
  } as TaskInstance
}

describe('TaskListRenderer AI task integration', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  test('does not render AI controls when the host lacks AI members', () => {
    const host = createBaseHost([createAiInstance()])
    new TaskListRenderer(host).render()

    expect(host.taskList.querySelector('.ai-task-run-button')).toBeNull()
  })

  test('renders the AI run button between the task name and the project column', () => {
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => true
    host.getActiveAiRun = () => undefined
    host.startAiRun = jest.fn()
    host.stopAiRun = jest.fn()

    new TaskListRenderer(host).render()

    const taskItem = host.taskList.querySelector('.task-item') as HTMLElement
    const button = taskItem.querySelector('.ai-task-run-button')
    expect(button).not.toBeNull()

    const children = Array.from(taskItem.children)
    const nameIndex = children.findIndex((el) =>
      el.classList.contains('task-name-container'),
    )
    const aiIndex = children.findIndex((el) =>
      el.querySelector('.ai-task-run-button') !== null || el.classList.contains('ai-task-run-button'),
    )
    const projectIndex = children.findIndex((el) =>
      el.classList.contains('taskchute-project-display'),
    )
    expect(nameIndex).toBeGreaterThanOrEqual(0)
    expect(aiIndex).toBeGreaterThan(nameIndex)
    if (projectIndex >= 0) {
      expect(aiIndex).toBeLessThan(projectIndex)
    }
  })

  test('clicking the AI run button calls startAiRun without selecting the row', () => {
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => true
    host.getActiveAiRun = () => undefined
    host.startAiRun = jest.fn()
    host.stopAiRun = jest.fn()

    new TaskListRenderer(host).render()

    const button = host.taskList.querySelector<HTMLButtonElement>(
      '.ai-task-run-button',
    )
    button?.click()

    expect(host.startAiRun).toHaveBeenCalledTimes(1)
    expect(host.selectTaskForKeyboard).not.toHaveBeenCalled()
  })

  test('renders stop control and chip when the host reports an active run', () => {
    const activeRun: AiRunRecord = {
      id: 'run-9',
      taskPath: 'TASKS/ai-sample.md',
      taskName: 'AI sample',
      host: 'claude',
      status: 'running',
      startedAt: Date.now(),
      events: [],
    }
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => true
    host.getActiveAiRun = () => activeRun
    host.startAiRun = jest.fn()
    host.stopAiRun = jest.fn()

    new TaskListRenderer(host).render()

    expect(
      host.taskList.querySelector('.ai-task-run-button--stop'),
    ).not.toBeNull()
    expect(
      host.taskList.querySelector('.ai-task-status-chip--running'),
    ).not.toBeNull()

    host.taskList
      .querySelector<HTMLButtonElement>('.ai-task-run-button--stop')
      ?.click()
    expect(host.stopAiRun).toHaveBeenCalledWith('run-9')
  })

  test('does not render AI controls when the feature toggle reports disabled', () => {
    const host = createBaseHost([createAiInstance()])
    host.isAiTaskFeatureEnabled = () => false
    host.getActiveAiRun = () => undefined
    host.startAiRun = jest.fn()
    host.stopAiRun = jest.fn()

    new TaskListRenderer(host).render()

    expect(host.taskList.querySelector('.ai-task-run-button')).toBeNull()
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
    } as TaskInstance
    const host = createBaseHost([plain])
    host.isAiTaskFeatureEnabled = () => true
    host.getActiveAiRun = () => undefined
    host.startAiRun = jest.fn()
    host.stopAiRun = jest.fn()

    new TaskListRenderer(host).render()

    expect(host.taskList.querySelector('.ai-task-run-button')).toBeNull()
  })
})
