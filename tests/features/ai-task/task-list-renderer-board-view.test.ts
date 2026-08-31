/**
 * TaskListRenderer board-view filter (render-only):
 *   - 'human' hides ai_task===true instances, 'ai' shows ONLY them,
 *     'mixed' (or an absent host callback) renders everything
 *   - the filter NEVER mutates host.taskInstances (same length, same refs)
 *   - updateTotalTasksCount is still invoked once per render regardless of
 *     the filter (its input — the full instance list — is unchanged)
 */
import TaskListRenderer, {
  TaskListRendererHost,
} from '../../../src/ui/tasklist/TaskListRenderer'
import type { AiTaskBoardView } from '../../../src/features/ai-task/types'
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

function makeInstance(
  path: string,
  frontmatter: Record<string, unknown>,
): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter,
      path,
      name: path,
      isRoutine: false,
    },
    instanceId: `inst-${path}`,
    state: 'idle',
    slotKey: 'none',
  }
}

function createHost(
  instances: TaskInstance[],
  boardView?: AiTaskBoardView,
): TaskListRendererHost {
  const taskList = document.body.createDiv({ cls: 'task-list' })
  const host: TaskListRendererHost = {
    taskList,
    taskInstances: instances,
    currentDate: new Date(2026, 6, 12),
    tv: (_key: string, fallback: string) => fallback,
    app: { workspace: { openLinkText: jest.fn() } },
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
  if (boardView !== undefined) {
    host.getAiTaskBoardView = () => boardView
  }
  return host
}

function renderedPaths(host: TaskListRendererHost): string[] {
  return Array.from(
    host.taskList.querySelectorAll<HTMLElement>('.task-item'),
  ).map((item) => item.getAttribute('data-task-path') ?? '')
}

const AI_PATH = 'TASKS/ai-one.md'
const AI_PATH_2 = 'TASKS/ai-two.md'
const HUMAN_PATH = 'TASKS/human.md'

function makeMixedInstances(): TaskInstance[] {
  return [
    makeInstance(AI_PATH, { ai_task: true }),
    makeInstance(HUMAN_PATH, {}),
    makeInstance(AI_PATH_2, { ai_task: true }),
  ]
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('TaskListRenderer board view filter', () => {
  test("'human' hides ai_task instances from the rendered list", () => {
    const instances = makeMixedInstances()
    const host = createHost(instances, 'human')

    new TaskListRenderer(host).render()

    expect(renderedPaths(host)).toEqual([HUMAN_PATH])
  })

  test("'ai' renders ONLY ai_task instances", () => {
    const instances = makeMixedInstances()
    const host = createHost(instances, 'ai')

    new TaskListRenderer(host).render()

    expect(renderedPaths(host)).toEqual([AI_PATH, AI_PATH_2])
  })

  test("'mixed' renders everything", () => {
    const host = createHost(makeMixedInstances(), 'mixed')

    new TaskListRenderer(host).render()

    expect(renderedPaths(host)).toEqual([AI_PATH, HUMAN_PATH, AI_PATH_2])
  })

  test('an absent host callback renders everything (feature-off contract)', () => {
    const host = createHost(makeMixedInstances())

    new TaskListRenderer(host).render()

    expect(renderedPaths(host)).toEqual([AI_PATH, HUMAN_PATH, AI_PATH_2])
  })

  test("frontmatter without a strict ai_task === true stays on the human board", () => {
    const host = createHost(
      [
        makeInstance('TASKS/string-flag.md', { ai_task: 'true' }),
        makeInstance('TASKS/false-flag.md', { ai_task: false }),
        makeInstance(AI_PATH, { ai_task: true }),
      ],
      'human',
    )

    new TaskListRenderer(host).render()

    expect(renderedPaths(host)).toEqual([
      'TASKS/string-flag.md',
      'TASKS/false-flag.md',
    ])
  })

  test('the filter never mutates host.taskInstances', () => {
    const instances = makeMixedInstances()
    const originalRefs = [...instances]
    const host = createHost(instances, 'human')

    new TaskListRenderer(host).render()

    expect(host.taskInstances).toHaveLength(3)
    expect(host.taskInstances).toEqual(originalRefs)
    for (let i = 0; i < originalRefs.length; i += 1) {
      expect(host.taskInstances[i]).toBe(originalRefs[i])
    }
  })

  test('updateTotalTasksCount still runs once per render with a filter active', () => {
    const host = createHost(makeMixedInstances(), 'ai')

    new TaskListRenderer(host).render()

    expect(host.updateTotalTasksCount).toHaveBeenCalledTimes(1)
  })
})
