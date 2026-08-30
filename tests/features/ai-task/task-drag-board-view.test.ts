/**
 * Drag & drop under a non-mixed board view (regression):
 *   - the dragstart payload written by TaskListRenderer identifies the row by
 *     its instanceId, not only by its index in the FILTERED render list
 *   - TaskDragController resolves the drop source by that identity, so under
 *     a 'human'/'ai' board view the dragged task itself moves — never the
 *     task that happens to sit at the same index in the UNFILTERED slot list
 */
import TaskListRenderer, {
  TaskListRendererHost,
} from '../../../src/ui/tasklist/TaskListRenderer'
import TaskDragController from '../../../src/ui/tasklist/TaskDragController'
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

const SLOT = '8:00-12:00'

function makeInstance(
  path: string,
  options: { aiTask?: boolean; order: number },
): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: options.aiTask === true ? { ai_task: true } : {},
      path,
      name: path,
      isRoutine: false,
    },
    instanceId: `inst-${path}`,
    state: 'idle',
    slotKey: SLOT,
    order: options.order,
  }
}

function sortByOrder(items: TaskInstance[]): TaskInstance[] {
  return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function createRendererHost(
  instances: TaskInstance[],
  boardView: 'human' | 'ai' | 'mixed',
): TaskListRendererHost {
  const taskList = document.body.createDiv({ cls: 'task-list' })
  return {
    taskList,
    taskInstances: instances,
    currentDate: new Date(2026, 6, 12),
    tv: (_key: string, fallback: string) => fallback,
    app: { workspace: { openLinkText: jest.fn() } },
    applyResponsiveClasses: jest.fn(),
    sortTaskInstancesByTimeOrder: jest.fn(),
    getTimeSlotKeys: () => ['0:00-8:00', SLOT, '12:00-16:00', '16:00-0:00'],
    sortByOrder,
    selectTaskForKeyboard: jest.fn(),
    registerManagedDomEvent: jest.fn(
      (target: Document | HTMLElement, event: string, handler: EventListener) => {
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
    getAiTaskBoardView: () => boardView,
  }
}

function createDragController(instances: TaskInstance[]) {
  const moveTaskToSlot = jest.fn()
  const controller = new TaskDragController({
    getTaskInstances: () => instances,
    sortByOrder,
    getStatePriority: (state: TaskInstance['state']) => {
      if (state === 'running') return 2
      if (state === 'idle') return 1
      return 0
    },
    normalizeState: (state: TaskInstance['state']) => state ?? 'idle',
    moveTaskToSlot,
    tv: (_key: string, fallback: string) => fallback,
  })
  return { controller, moveTaskToSlot }
}

/** Fire the renderer-attached dragstart handler and return the payload */
function captureDragPayload(taskItem: HTMLElement): string {
  const dragHandle = taskItem.querySelector<HTMLElement>('.drag-handle')
  expect(dragHandle).not.toBeNull()
  let payload = ''
  const dataTransfer = {
    setData: (_format: string, data: string) => {
      payload = data
    },
    getData: () => payload,
  } as unknown as DataTransfer
  dragHandle!.dispatchEvent(
    new DragEvent('dragstart', { bubbles: true, dataTransfer }),
  )
  return payload
}

function dropTarget(): HTMLElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ top: 0, height: 40 }),
  })
  return element
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('drag & drop under a filtered board view', () => {
  test("the dragstart payload carries the row's instanceId", () => {
    const instances = [
      makeInstance('TASKS/ai.md', { aiTask: true, order: 0 }),
      makeInstance('TASKS/human-a.md', { order: 1 }),
      makeInstance('TASKS/human-b.md', { order: 2 }),
    ]
    const host = createRendererHost(instances, 'human')
    new TaskListRenderer(host).render()

    const humanB = host.taskList.querySelector<HTMLElement>(
      '[data-instance-id="inst-TASKS/human-b.md"]',
    )
    expect(humanB).not.toBeNull()
    const payload = captureDragPayload(humanB!)

    expect(payload).toContain('inst-TASKS/human-b.md')
  })

  test("dragging a task in the 'human' view moves THAT task, not the one at its filtered index", () => {
    // Slot layout [AI, humanA, humanB]: in the 'human' view humanB renders at
    // index 1, which positionally resolves to humanA in the unfiltered list.
    const instances = [
      makeInstance('TASKS/ai.md', { aiTask: true, order: 0 }),
      makeInstance('TASKS/human-a.md', { order: 1 }),
      makeInstance('TASKS/human-b.md', { order: 2 }),
    ]
    const humanA = instances[1]
    const humanB = instances[2]
    const host = createRendererHost(instances, 'human')
    new TaskListRenderer(host).render()

    const humanBItem = host.taskList.querySelector<HTMLElement>(
      '[data-instance-id="inst-TASKS/human-b.md"]',
    )
    const payload = captureDragPayload(humanBItem!)

    const { controller, moveTaskToSlot } = createDragController(instances)
    controller.handleDrop(
      {
        dataTransfer: { getData: () => payload },
        clientY: 5,
      } as unknown as DragEvent,
      dropTarget(),
      humanA,
    )

    expect(moveTaskToSlot).toHaveBeenCalledTimes(1)
    expect(moveTaskToSlot.mock.calls[0][0]).toBe(humanB)
  })

  test("dropping on a slot header in the 'ai' view also resolves the dragged task by identity", () => {
    const instances = [
      makeInstance('TASKS/human-a.md', { order: 0 }),
      makeInstance('TASKS/ai-a.md', { aiTask: true, order: 1 }),
      makeInstance('TASKS/ai-b.md', { aiTask: true, order: 2 }),
    ]
    const aiB = instances[2]
    const host = createRendererHost(instances, 'ai')
    new TaskListRenderer(host).render()

    const aiBItem = host.taskList.querySelector<HTMLElement>(
      '[data-instance-id="inst-TASKS/ai-b.md"]',
    )
    const payload = captureDragPayload(aiBItem!)

    const { controller, moveTaskToSlot } = createDragController(instances)
    controller.handleSlotDrop(
      { dataTransfer: { getData: () => payload } } as unknown as DragEvent,
      '12:00-16:00',
    )

    expect(moveTaskToSlot).toHaveBeenCalledTimes(1)
    expect(moveTaskToSlot.mock.calls[0][0]).toBe(aiB)
    expect(moveTaskToSlot.mock.calls[0][1]).toBe('12:00-16:00')
  })
})
