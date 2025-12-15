import { TFile } from 'obsidian'
import TaskScheduleController, { TaskScheduleControllerHost } from '../../../src/ui/task/TaskScheduleController'
import type { TaskInstance } from '../../../src/types'

jest.mock('obsidian', () => {
  const Actual = jest.requireActual('obsidian')
  return {
    ...Actual,
    Notice: jest.fn(),
    TFile: class MockTFile {},
  }
})

describe('TaskScheduleController', () => {
  const createCalendarFactory = () => {
    const handles: Array<{ open: jest.Mock; close: jest.Mock; options: unknown }> = []

    const factory = jest.fn((options) => {
      const open = jest.fn()
      const close = jest.fn(() => {
        options.onClose?.()
      })
      if (typeof options.registerDisposer === 'function') {
        options.registerDisposer(() => close())
      }
      const handle = { open, close, options }
      handles.push(handle)
      return handle
    })

    return { factory, handles }
  }

  const createHost = (overrides: Partial<TaskScheduleControllerHost> = {}) => {
    const vault = {
      getAbstractFileByPath: jest.fn((path: string) => {
        if (path === 'TASKS/sample.md') {
          const file = new (TFile)()
          file.path = path
          return file
        }
        return null
      }),
    }

    const fileManager = {
      processFrontMatter: jest.fn().mockResolvedValue(undefined),
    }

    const host: TaskScheduleControllerHost = {
      tv: (_key, fallback) => fallback,
      getInstanceDisplayTitle: () => 'Sample',
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
      app: {
        vault,
        fileManager,
      },
      getCurrentDate: () => new Date('2025-10-09T00:00:00Z'),
      registerDisposer: jest.fn(),
      ...overrides,
    }

    return { host, vault, fileManager }
  }

  const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => ({
    task: {
      path: overrides.task?.path ?? 'TASKS/sample.md',
      frontmatter: overrides.task?.frontmatter ?? {},
      name: overrides.task?.name ?? 'sample',
    },
    ...overrides,
  } as TaskInstance)

  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('moveTaskToDate writes frontmatter and reloads', async () => {
    const { host, fileManager } = createHost()
    const controller = new TaskScheduleController(host)
    const instance = createInstance()

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
  })

  test('clearTaskTargetDate removes frontmatter and reloads', async () => {
    const { host, fileManager } = createHost()
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      task: {
        path: 'TASKS/sample.md',
        frontmatter: { target_date: '2025-10-01' },
        name: 'sample',
      },
    })

    await controller.clearTaskTargetDate(instance)

    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
  })

  test('showTaskMoveDatePicker creates calendar, registers disposer, and opens it', () => {
    const { host } = createHost()
    const { factory, handles } = createCalendarFactory()
    const controller = new TaskScheduleController(host, { createCalendar: factory })
    const instance = createInstance()
    const anchor = document.createElement('button')

    controller.showTaskMoveDatePicker(instance, anchor)

    expect(factory).toHaveBeenCalled()
    expect(handles[0]?.open).toHaveBeenCalled()
    expect(host.registerDisposer).toHaveBeenCalledTimes(1)

    const disposer = (host.registerDisposer as jest.Mock).mock.calls[0][0] as () => void
    disposer()
    expect(handles[0]?.close).toHaveBeenCalledTimes(1)
  })

  test('showTaskMoveDatePicker closes existing calendar before opening new one', () => {
    const { host } = createHost()
    const { factory, handles } = createCalendarFactory()
    const controller = new TaskScheduleController(host, { createCalendar: factory })
    const instance = createInstance()
    const anchor = document.createElement('button')

    controller.showTaskMoveDatePicker(instance, anchor)
    controller.showTaskMoveDatePicker(instance, anchor)

    expect(handles[0]?.close).toHaveBeenCalled()
    expect(handles[1]?.open).toHaveBeenCalled()
  })

  describe('duplicate instance move behavior', () => {
    test('moveTaskToDate for duplicate instance should NOT modify frontmatter, only call moveDuplicateInstanceToDate', async () => {
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const isDuplicateInstance = jest.fn().mockReturnValue(true)
      const { host, fileManager } = createHost({
        isDuplicateInstance,
        moveDuplicateInstanceToDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({ instanceId: 'dup-123' })

      await controller.moveTaskToDate(instance, '2025-10-10')

      // frontmatter should NOT be modified for duplicate instances
      expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
      // moveDuplicateInstanceToDate should be called instead
      expect(moveDuplicateInstanceToDate).toHaveBeenCalledWith(instance, '2025-10-10')
      expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
    })

    test('moveTaskToDate for non-duplicate instance should modify frontmatter as before', async () => {
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const isDuplicateInstance = jest.fn().mockReturnValue(false)
      const { host, fileManager } = createHost({
        isDuplicateInstance,
        moveDuplicateInstanceToDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance()

      await controller.moveTaskToDate(instance, '2025-10-10')

      // frontmatter should be modified for non-duplicate instances
      expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
      // moveDuplicateInstanceToDate should NOT be called
      expect(moveDuplicateInstanceToDate).not.toHaveBeenCalled()
      expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
    })

    test('moveTaskToDate for duplicate instance should remove it from current date duplicatedInstances', async () => {
      const removeDuplicateInstanceFromCurrentDate = jest.fn().mockResolvedValue(undefined)
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const isDuplicateInstance = jest.fn().mockReturnValue(true)
      const { host, fileManager } = createHost({
        isDuplicateInstance,
        moveDuplicateInstanceToDate,
        removeDuplicateInstanceFromCurrentDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({ instanceId: 'dup-123' })

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
      expect(removeDuplicateInstanceFromCurrentDate).toHaveBeenCalledWith(instance)
      expect(moveDuplicateInstanceToDate).toHaveBeenCalledWith(instance, '2025-10-10')
    })

    test('moveTaskToDate without isDuplicateInstance should fallback to frontmatter modification (backward compatibility)', async () => {
      // When host does not provide isDuplicateInstance, treat as non-duplicate
      const { host, fileManager } = createHost()
      const controller = new TaskScheduleController(host)
      const instance = createInstance()

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
      expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
    })
  })

  describe('routine move to past date', () => {
    test('hides routine on current date when moved to past', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host, fileManager } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          isRoutine: true,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-08')

      expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
      expect(hideRoutineInstanceForDate).toHaveBeenCalledWith(instance, '2025-10-09')
    })

    test('does not hide when target is future', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          isRoutine: true,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(hideRoutineInstanceForDate).not.toHaveBeenCalled()
    })

    test('does not hide non-routine even when target is past', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          isRoutine: false,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-08')

      expect(hideRoutineInstanceForDate).not.toHaveBeenCalled()
    })

    test('hides previous target date when retargeting', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: { target_date: '2025-10-24' },
          name: 'sample',
          isRoutine: true,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-17')

      expect(hideRoutineInstanceForDate).toHaveBeenCalledWith(instance, '2025-10-24')
    })
  })
})
