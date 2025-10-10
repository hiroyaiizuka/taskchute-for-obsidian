const NoticeMock = jest.fn()

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn((message: string) => {
      NoticeMock(message)
      return {}
    }),
    setIcon: jest.fn(),
  }
})

import TaskDragController from '../../../src/ui/task-list/TaskDragController'
import { TaskInstance } from '../../../src/types'

describe('TaskDragController', () => {
  function createTask(overrides: Partial<TaskInstance> = {}): TaskInstance {
    return {
      task: {
        name: 'Sample',
        path: 'TASKS/sample.md',
        isRoutine: false,
      },
      instanceId: overrides.instanceId ?? 'instance-1',
      slotKey: overrides.slotKey ?? '8:00-12:00',
      state: overrides.state ?? 'idle',
      order: overrides.order,
      ...overrides,
    } as TaskInstance
  }

  function createHost(instances: TaskInstance[] = []) {
    const taskInstances = instances
    const moveTaskToSlot = jest.fn()
    const host = {
      getTaskInstances: () => taskInstances,
      sortByOrder: (items: TaskInstance[]) => [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      getStatePriority: (state: TaskInstance['state']) => {
        if (state === 'running') return 2
        if (state === 'idle') return 1
        return 0
      },
      normalizeState: (state: TaskInstance['state']) => state ?? 'idle',
      moveTaskToSlot,
      tv: (_key: string, fallback: string) => fallback,
    }
    const controller = new TaskDragController(host)
    return { controller, host, moveTaskToSlot, taskInstances }
  }

  test('handleDragOver toggles classes for upper and lower halves', () => {
    const inst = createTask()
    const { controller } = createHost([inst])
    const element = document.createElement('div')
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 40 }),
    })

    controller.handleDragOver({ preventDefault: jest.fn(), clientY: 35 } as unknown as DragEvent, element, inst)
    expect(element.classList.contains('dragover-bottom')).toBe(true)

    controller.handleDragOver({ preventDefault: jest.fn(), clientY: 5 } as unknown as DragEvent, element, inst)
    expect(element.classList.contains('dragover-top')).toBe(true)
  })

  test('handleDrop computes position and delegates to moveTaskToSlot', () => {
    const source = createTask({ instanceId: 'source', order: 0 })
    const target = createTask({ instanceId: 'target', order: 1 })
    const { controller, moveTaskToSlot } = createHost([source, target])

    const element = document.createElement('div')
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 40 }),
    })
    const event = {
      dataTransfer: { getData: () => '8:00-12:00::0' },
      clientY: 5,
    } as unknown as DragEvent

    controller.handleDrop(event, element, target)
    expect(moveTaskToSlot).toHaveBeenCalledWith(source, '8:00-12:00', 0)
    expect(element.className).toBe('')
  })

  beforeEach(() => {
    NoticeMock.mockClear()
  })

  test('handleSlotDrop appends to slot end respecting state grouping', () => {
    const source = createTask({ instanceId: 'source', order: 0 })
    const sibling = createTask({ instanceId: 'sibling', order: 1 })
    const { controller, moveTaskToSlot } = createHost([source, sibling])

    const event = {
      dataTransfer: { getData: () => '8:00-12:00::0' },
    } as unknown as DragEvent

    controller.handleSlotDrop(event, '8:00-12:00')
    expect(moveTaskToSlot).toHaveBeenCalledWith(source, '8:00-12:00', 1)
  })

  test('handleDrop shows notice when moveTaskToSlot rejects', async () => {
    const source = createTask({ instanceId: 'source', order: 0 })
    const target = createTask({ instanceId: 'target', order: 1 })
    const { controller, moveTaskToSlot } = createHost([source, target])
    moveTaskToSlot.mockRejectedValueOnce(new Error('persist failed'))

    const element = document.createElement('div')
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 40 }),
    })
    const event = {
      dataTransfer: { getData: () => '8:00-12:00::0' },
      clientY: 5,
    } as unknown as DragEvent

    controller.handleDrop(event, element, target)

    await Promise.resolve()
    expect(moveTaskToSlot).toHaveBeenCalledWith(source, '8:00-12:00', 0)
    expect(NoticeMock).toHaveBeenCalledWith('Failed to move task')
  })

  test('handleSlotDrop shows notice when moveTaskToSlot rejects', async () => {
    const source = createTask({ instanceId: 'source', order: 0 })
    const sibling = createTask({ instanceId: 'sibling', order: 1 })
    const { controller, moveTaskToSlot } = createHost([source, sibling])
    moveTaskToSlot.mockRejectedValueOnce(new Error('persist failed'))

    const event = {
      dataTransfer: { getData: () => '8:00-12:00::0' },
    } as unknown as DragEvent

    controller.handleSlotDrop(event, '8:00-12:00')

    await Promise.resolve()
    expect(moveTaskToSlot).toHaveBeenCalledWith(source, '8:00-12:00', 1)
    expect(NoticeMock).toHaveBeenCalledWith('Failed to move task')
  })
})
