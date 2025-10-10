import type { App } from 'obsidian'
import { Notice, TFile } from 'obsidian'
import RoutineController, {
  RoutineControllerHost,
} from '../../../src/ui/routine/RoutineController'
import type { RoutineTaskShape } from '../../../src/types/routine'
import type { TaskChutePluginLike } from '../../../src/types'

describe('RoutineController', () => {
  const baseWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const noticeMock = Notice as unknown as jest.Mock

  const createHost = (overrides?: Partial<RoutineControllerHost>) => {
    const frontmatterStore = new Map<string, Record<string, unknown>>()
    const createFile = (path: string): TFile => {
      const file = new TFile()
      const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? Object.getPrototypeOf(file)
      if (Object.getPrototypeOf(file) !== proto && proto) {
        Object.setPrototypeOf(file, proto)
      }
      if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
        ;(file as { constructor?: unknown }).constructor = TFile
      }
      file.path = path
      file.basename = path.split('/').pop() ?? path
      file.extension = 'md'
      return file
    }
    const fileManager = {
      processFrontMatter: jest.fn(async (file: TFile, updater: (fm: Record<string, unknown>) => Record<string, unknown>) => {
        const existing = frontmatterStore.get(file.path) ?? {}
        const mutated = updater(existing)
        frontmatterStore.set(file.path, mutated)
      }),
    }
    const vault = {
      getMarkdownFiles: jest.fn(() => [] as TFile[]),
      getAbstractFileByPath: jest.fn((path: string) => {
        if (!frontmatterStore.has(path)) {
          frontmatterStore.set(path, {})
        }
        return createFile(path)
      }),
    }
    const metadataCache = {
      getFileCache: jest.fn(() => undefined),
    }
    const plugin = {
      pathManager: {
        getTaskFolderPath: () => 'TASKS',
      },
    } as unknown as TaskChutePluginLike
    const app = {
      vault,
      metadataCache,
      fileManager,
    } as unknown as App
    const host: RoutineControllerHost = {
      app,
      plugin,
      tv: (key, fallback, vars) => {
        if (!vars) return fallback
        return fallback.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
      },
      getWeekdayNames: () => [...baseWeekdays],
      reloadTasksAndRestore: jest.fn(async () => {}),
      getCurrentDate: () => new Date('2025-10-09T00:00:00Z'),
      ...overrides,
    }
    return { host, frontmatterStore, vault, fileManager }
  }

  const createButton = () => {
    const button = document.createElement('button')
    button.classList.add('routine-button')
    return button
  }

  const createTask = (overrides?: Partial<RoutineTaskShape>): RoutineTaskShape => ({
    title: 'Sample Task',
    path: 'TASKS/sample.md',
    isRoutine: false,
    scheduledTime: '09:00',
    routine_interval: 1,
    routine_enabled: true,
    routine_type: 'daily',
    ...overrides,
  })

  beforeEach(() => {
    noticeMock.mockClear()
    document.body.innerHTML = ''
  })

  it('detaches routine when toggleRoutine is called for an active routine', async () => {
    const { host, frontmatterStore, fileManager } = createHost()
    const controller = new RoutineController(host)
    const task = createTask({ isRoutine: true, scheduledTime: '08:00' })
    const button = createButton()
    button.classList.add('active')
    await controller.toggleRoutine(task, button)
    expect(fileManager.processFrontMatter).toHaveBeenCalled()
    const fm = frontmatterStore.get(task.path!)
    expect(fm?.isRoutine).toBe(false)
    expect(task.isRoutine).toBe(false)
    expect(button.classList.contains('active')).toBe(false)
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
    expect(noticeMock).toHaveBeenCalled()
  })

  it('opens routine modal when toggling a non-routine task', async () => {
    const { host } = createHost()
    const controller = new RoutineController(host)
    const task = createTask({ isRoutine: false })
    const button = createButton()
    const spy = jest.spyOn(controller as RoutineController, 'showRoutineEditModal')
    await controller.toggleRoutine(task, button)
    expect(spy).toHaveBeenCalledWith(task, button)
  })

  it('sets routine details via setRoutineTaskWithDetails', async () => {
    const { host, frontmatterStore } = createHost()
    const controller = new RoutineController(host)
    const task = createTask({ isRoutine: false })
    const button = createButton()
    await controller.setRoutineTaskWithDetails(task, button, '07:30', 'weekly', {
      weekdays: [1],
      interval: 2,
      enabled: true,
    })
    const fm = frontmatterStore.get(task.path!)
    expect(fm?.isRoutine).toBe(true)
    expect(fm?.routine_type).toBe('weekly')
    expect(task.isRoutine).toBe(true)
    expect(task.weekday).toBe(1)
    expect(button.classList.contains('active')).toBe(true)
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
  })
})
