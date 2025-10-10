import { Notice, TFile } from 'obsidian'
import TaskMutationService, { TaskMutationHost } from '../../src/features/core/services/TaskMutationService'
import { TaskInstance, TaskData, HiddenRoutine, DeletedInstance } from '../../src/types'
import type DayStateStoreService from '../../src/services/DayStateStoreService'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

const NoticeMock = Notice as unknown as jest.Mock

function createTask(path: string, overrides: Partial<TaskData> = {}): TaskData {
  return {
    path,
    name: path.split('/').pop() ?? 'Task',
    isRoutine: false,
    ...overrides,
  } as TaskData
}

function createMockTFile(path: string): TFile {
  const file = new TFile()
  const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? {}
  if (Object.getPrototypeOf(file) !== proto) {
    Object.setPrototypeOf(file, proto)
  }
  if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
    (file as { constructor?: unknown }).constructor = TFile
  }
  file.path = path
  file.basename = path.split('/').pop() ?? 'task'
  file.extension = 'md'
  return file
}

type HostStub = TaskMutationHost & {
  taskInstances: TaskInstance[]
  tasks: TaskData[]
  dayState: {
    hiddenRoutines: HiddenRoutine[]
    deletedInstances: DeletedInstance[]
    duplicatedInstances: Array<{ instanceId?: string; path?: string; slotKey?: string }>
    slotOverrides: Record<string, string>
    orders: Record<string, number>
  }
  logSnapshot: { taskExecutions: Record<string, unknown[]>; dailySummary: Record<string, Record<string, unknown>> }
}

function createHost(overrides: Partial<HostStub> = {}): HostStub {
  const taskInstances: TaskInstance[] = overrides.taskInstances ?? []
  const tasks: TaskData[] = overrides.tasks ?? []
  const dayState = overrides.dayState ?? {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
  }
  const logSnapshot = overrides.logSnapshot ?? {
    taskExecutions: {},
    dailySummary: {},
  }
  const host: HostStub = {
    tv: (_key: string, fallback: string) => fallback,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(async () => JSON.stringify(logSnapshot)),
        modify: jest.fn(async (_file, data: string) => {
          Object.assign(logSnapshot, JSON.parse(data))
        }),
        create: jest.fn(),
      },
      fileManager: {
        trashFile: jest.fn(async () => {}),
      },
    },
    plugin: {
      settings: { slotKeys: {} },
      saveSettings: jest.fn(async () => {}),
      pathManager: {
        getLogDataPath: () => 'LOGS',
        ensureFolderExists: jest.fn(async () => {}),
      },
    },
    taskInstances,
    tasks,
    renderTaskList: jest.fn(),
    generateInstanceId: (_task: TaskData, date: string) => `${date}-${Math.random().toString(36).slice(2, 9)}`,
    getInstanceDisplayTitle: (inst: TaskInstance) => inst.task.name ?? 'Task',
    ensureDayStateForCurrentDate: jest.fn(async () => {}),
    getCurrentDayState: () => dayState,
    persistDayState: jest.fn(async () => {}),
    getCurrentDateString: () => '2025-10-09',
    calculateSimpleOrder: (index: number) => index * 100,
    normalizeState: (state) => {
      if (state === 'done') return 'done'
      if (state === 'running' || state === 'paused') return 'running'
      return 'idle'
    },
    saveTaskOrders: jest.fn(async () => {}),
    sortTaskInstancesByTimeOrder: jest.fn(() => {}),
    getOrderKey: (inst: TaskInstance) => `${inst.task.path}::${inst.slotKey ?? 'none'}`,
    dayStateManager: {
      getDeleted: jest.fn(() => dayState.deletedInstances),
      setDeleted: jest.fn((entries: DeletedInstance[]) => {
        dayState.deletedInstances = entries
      }),
    } as unknown as DayStateStoreService,
    persistSlotAssignment: jest.fn(),
    tasks,
    taskInstances,
    dayState,
    logSnapshot,
    ...overrides,
  }
  return host
}

describe('TaskMutationService', () => {
  beforeEach(() => {
    NoticeMock.mockClear()
  })

  test('duplicateInstance adds duplicated metadata and renders', async () => {
    const task = createTask('TASKS/base.md')
    const instance: TaskInstance = {
      task,
      instanceId: 'instance-1',
      state: 'idle',
      slotKey: '8:00-12:00',
    } as TaskInstance
    const host = createHost({ taskInstances: [instance], tasks: [task] })
    const service = new TaskMutationService(host)

    const result = (await service.duplicateInstance(instance, { returnInstance: true })) as TaskInstance

    expect(result).toBeDefined()
    expect(host.taskInstances).toHaveLength(2)
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(host.dayState.duplicatedInstances.some((dup) => dup.instanceId === result.instanceId)).toBe(true)
  })

  test('duplicateInstance surfaces failure notice when ensureDayState throws', async () => {
    const task = createTask('TASKS/dup-failure.md')
    const instance: TaskInstance = {
      task,
      instanceId: 'instance-failure',
      state: 'idle',
      slotKey: '8:00-12:00',
    } as TaskInstance
    const host = createHost({ taskInstances: [instance], tasks: [task] })
    host.ensureDayStateForCurrentDate = jest.fn(async () => {
      throw new Error('ensure failed')
    })
    const service = new TaskMutationService(host)

    const result = await service.duplicateInstance(instance)

    expect(result).toBeUndefined()
    expect(host.taskInstances).toHaveLength(1)
    expect(NoticeMock).toHaveBeenCalledWith(host.tv('notices.taskDuplicateFailed', 'Failed to duplicate task'))
  })

  test('deleteTask removes non-routine instance and records permanent deletion', async () => {
    const task = createTask('TASKS/sample.md')
    const file = createMockTFile('TASKS/sample.md')
    task.file = file
    const instance: TaskInstance = {
      task,
      instanceId: 'instance-del',
      state: 'idle',
      slotKey: 'none',
    } as TaskInstance
    const host = createHost({ taskInstances: [instance], tasks: [task] })
    host.app.fileManager.trashFile = jest.fn(async () => {})
    const service = new TaskMutationService(host)

    await service.deleteTask(instance)

    expect(host.taskInstances).toHaveLength(0)
    expect(host.app.fileManager.trashFile).toHaveBeenCalled()
    expect(host.dayState.deletedInstances.some((entry) => entry.deletionType === 'permanent')).toBe(true)
  })

  test('persistSlotAssignment stores overrides for routine and settings for non-routine', () => {
    const routineTask = createTask('TASKS/routine.md', { isRoutine: true, scheduledTime: '08:00' })
    const routineInstance: TaskInstance = {
      task: routineTask,
      instanceId: 'routine-1',
      slotKey: '12:00-16:00',
      state: 'idle',
    } as TaskInstance
    const nonRoutineTask = createTask('TASKS/non.md')
    const nonRoutineInstance: TaskInstance = {
      task: nonRoutineTask,
      instanceId: 'non-1',
      slotKey: '16:00-0:00',
      state: 'idle',
    } as TaskInstance
    const host = createHost()
    const service = new TaskMutationService(host)

    service.persistSlotAssignment(routineInstance)
    service.persistSlotAssignment(nonRoutineInstance)

    expect(host.dayState.slotOverrides['TASKS/routine.md']).toBe('12:00-16:00')
    expect(host.plugin.settings.slotKeys?.['TASKS/non.md']).toBe('16:00-0:00')
  })

  test('moveInstanceToSlot updates slot, order, and persists metadata', async () => {
    const task = createTask('TASKS/move.md')
    const peer: TaskInstance = {
      task,
      instanceId: 'peer',
      state: 'idle',
      slotKey: '12:00-16:00',
      order: 100,
    } as TaskInstance
    const target: TaskInstance = {
      task,
      instanceId: 'move-1',
      state: 'idle',
      slotKey: 'none',
    } as TaskInstance
    const host = createHost({ taskInstances: [peer, target] })
    const service = new TaskMutationService(host)

    await service.moveInstanceToSlot(target, '12:00-16:00', 0)

    expect(target.slotKey).toBe('12:00-16:00')
    expect(target.order).toBe(0)
    expect(host.saveTaskOrders).toHaveBeenCalled()
    expect(host.sortTaskInstancesByTimeOrder).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
  })

  test('moveInstanceToSlot handles failure and restores previous slot', async () => {
    const task = createTask('TASKS/error-move.md')
    const inst: TaskInstance = {
      task,
      instanceId: 'moving-1',
      state: 'idle',
      slotKey: '8:00-12:00',
      order: 200,
    } as TaskInstance
    const host = createHost({ taskInstances: [inst] })
    host.saveTaskOrders = jest.fn().mockRejectedValueOnce(new Error('persist failed'))
    const service = new TaskMutationService(host)

    await service.moveInstanceToSlot(inst, '12:00-16:00', 0)

    expect(inst.slotKey).toBe('8:00-12:00')
    expect(inst.order).toBe(200)
    expect(host.sortTaskInstancesByTimeOrder).not.toHaveBeenCalled()
    expect(host.renderTaskList).not.toHaveBeenCalled()
    expect(NoticeMock).toHaveBeenCalledWith('Failed to move task')
  })

  test('deleteTaskLogsByInstanceId removes matching entries and writes snapshot', async () => {
    const logFile = createMockTFile('LOGS/2025-10-tasks.json')
    const host = createHost()
    host.app.vault.getAbstractFileByPath = jest.fn(() => logFile)
    host.logSnapshot.taskExecutions = {
      '2025-10-09': [
        { instanceId: 'keep-1' },
        { instanceId: 'remove-me' },
      ],
    }
    host.app.vault.read = jest.fn(async () => JSON.stringify(host.logSnapshot))
    const modifySpy = jest.fn(async (_file, data: string) => {
      Object.assign(host.logSnapshot, JSON.parse(data))
    })
    host.app.vault.modify = modifySpy
    const service = new TaskMutationService(host)

    const removed = await service.deleteTaskLogsByInstanceId('TASKS/sample.md', 'remove-me')

    expect(removed).toBe(1)
    expect(modifySpy).toHaveBeenCalled()
    expect(host.logSnapshot.taskExecutions['2025-10-09']).toEqual([{ instanceId: 'keep-1' }])
  })

  test('deleteTaskLogsByInstanceId returns zero when log file missing', async () => {
    const host = createHost()
    host.app.vault.getAbstractFileByPath = jest.fn(() => null)
    const service = new TaskMutationService(host)

    const removed = await service.deleteTaskLogsByInstanceId('TASKS/sample.md', 'unknown')

    expect(removed).toBe(0)
    expect(host.app.vault.modify).not.toHaveBeenCalled()
  })

  test('deleteTask hides routine instance and records hidden entry', async () => {
    const routineTask = createTask('TASKS/routine.md', { isRoutine: true })
    const instance: TaskInstance = {
      task: routineTask,
      instanceId: 'routine-1',
      state: 'idle',
      slotKey: '8:00-12:00',
    } as TaskInstance
    const host = createHost({ taskInstances: [instance], tasks: [routineTask] })
    const service = new TaskMutationService(host)

    await service.deleteTask(instance)

    expect(host.dayState.hiddenRoutines).toEqual([{ path: 'TASKS/routine.md', instanceId: null }])
    expect(host.persistDayState).toHaveBeenCalled()
    expect(host.taskInstances).toHaveLength(0)
  })

  test('handleTaskFileDeletion fallback adds notice when trashFile fails', async () => {
    const file = createMockTFile('TASKS/error.md')
    const task = createTask('TASKS/error.md', { file })
    const instance: TaskInstance = {
      task,
      instanceId: 'error-1',
      state: 'idle',
      slotKey: 'none',
    } as TaskInstance
    const host = createHost({ taskInstances: [instance], tasks: [task] })
    host.app.fileManager.trashFile = jest.fn(async () => {
      throw new Error('trash failed')
    })
    const service = new TaskMutationService(host)

    await service.deleteTask(instance)

    expect(host.taskInstances).toHaveLength(0)
    expect(host.tasks).toHaveLength(0)
    expect(NoticeMock).toHaveBeenCalledWith(host.tv('notices.taskRemovedFromToday', 'Removed task from today.'))
  })

  test('deleteTask surfaces notice when deletion flow throws', async () => {
    const task = createTask('TASKS/failure.md')
    const file = createMockTFile('TASKS/failure.md')
    task.file = file
    const instance: TaskInstance = {
      task,
      instanceId: 'fail-1',
      state: 'idle',
      slotKey: 'none',
    } as TaskInstance
    const host = createHost({ taskInstances: [instance], tasks: [task] })
    host.ensureDayStateForCurrentDate = jest.fn(async () => {
      throw new Error('load failure')
    })
    const service = new TaskMutationService(host)

    await service.deleteTask(instance)

    expect(host.taskInstances).toContain(instance)
    expect(NoticeMock).toHaveBeenCalledWith(host.tv('notices.taskDeleteFailed', 'Failed to delete task'))
  })
})
