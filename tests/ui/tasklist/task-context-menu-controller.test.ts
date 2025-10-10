import TaskContextMenuController, {
  type TaskContextMenuHost,
} from '../../../src/ui/tasklist/TaskContextMenuController'
import type { TaskInstance } from '../../../src/types'
import { Menu } from 'obsidian'

type MenuItemHandler = () => void | Promise<void>

type FakeMenuItem = {
  title: string
  icon?: string
  handler?: MenuItemHandler
  setTitle: (title: string) => FakeMenuItem
  setIcon: (icon: string) => FakeMenuItem
  onClick: (handler: MenuItemHandler) => FakeMenuItem
}

type FakeMenu = {
  items: FakeMenuItem[]
  showAtMouseEvent: jest.Mock<void, [MouseEvent]>
}

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')

  class TestMenuItem implements FakeMenuItem {
    title = ''
    icon?: string
    handler?: MenuItemHandler

    setTitle(title: string): FakeMenuItem {
      this.title = title
      return this
    }

    setIcon(icon: string): FakeMenuItem {
      this.icon = icon
      return this
    }

    onClick(handler: MenuItemHandler): FakeMenuItem {
      this.handler = handler
      return this
    }
  }

  class TestMenu implements FakeMenu {
    items: FakeMenuItem[] = []
    showAtMouseEvent = jest.fn<void, [MouseEvent]>()

    addItem(callback: (item: FakeMenuItem) => void): void {
      const item = new TestMenuItem()
      callback(item)
      this.items.push(item)
    }
  }

  const MenuMock = jest.fn(() => new TestMenu())

  return {
    ...actual,
    Menu: MenuMock,
  }
})

const getMenuInstance = (): FakeMenu => {
  const MenuMock = Menu as unknown as jest.MockedClass<typeof Menu>
  const result = MenuMock.mock.results.at(-1)?.value
  if (!result) {
    throw new Error('Menu instance not created')
  }
  return result as unknown as FakeMenu
}

const createHost = (
  overrides: Partial<TaskContextMenuHost> = {},
): TaskContextMenuHost => ({
  tv: (_key, fallback) => fallback,
  app: {} as unknown as TaskContextMenuHost['app'],
  startInstance: jest.fn().mockResolvedValue(undefined),
  stopInstance: jest.fn().mockResolvedValue(undefined),
  resetTaskToIdle: jest.fn().mockResolvedValue(undefined),
  duplicateInstance: jest.fn().mockResolvedValue(undefined),
  deleteRoutineTask: jest.fn().mockResolvedValue(undefined),
  deleteNonRoutineTask: jest.fn().mockResolvedValue(undefined),
  hasExecutionHistory: jest.fn().mockResolvedValue(false),
  ...overrides,
})

const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance =>
  ({
    instanceId: 'inst-1',
    state: 'idle',
    task: {
      path: 'Tasks/sample.md',
      isRoutine: false,
      name: 'Sample task',
    },
    slotKey: 'none',
    ...overrides,
  } as TaskInstance)

describe('TaskContextMenuController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows start/duplicate/delete for idle task', () => {
    const host = createHost()
    const controller = new TaskContextMenuController(host)
    const instance = createInstance({ state: 'idle' })

    controller.show(new MouseEvent('contextmenu'), instance)

    const menu = getMenuInstance()
    const titles = menu.items.map((item) => item.title)
    expect(titles).toEqual([
      'Start',
      'Duplicate task',
      'Delete task',
    ])
    expect(menu.showAtMouseEvent).toHaveBeenCalledTimes(1)
  })

  it('shows stop/reset for running task', () => {
    const host = createHost()
    const controller = new TaskContextMenuController(host)
    const instance = createInstance({ state: 'running' })

    controller.show(new MouseEvent('contextmenu'), instance)

    const menu = getMenuInstance()
    const titles = menu.items.map((item) => item.title)
    expect(titles).toEqual([
      'Stop',
      'Reset to not started',
      'Duplicate task',
      'Delete task',
    ])
  })

  it('invokes duplicate and delete actions', async () => {
    const deleteRoutineTask = jest.fn().mockResolvedValue(undefined)
    const host = createHost({ deleteRoutineTask })
    const controller = new TaskContextMenuController(host)
    const instance = createInstance({
      state: 'running',
      task: { path: 'Tasks/sample.md', isRoutine: true, name: 'Sample task' },
    })

    controller.show(new MouseEvent('contextmenu'), instance)
    const menu = getMenuInstance()

    const duplicateItem = menu.items.find((item) => item.title === 'Duplicate task')
    const deleteItem = menu.items.find((item) => item.title === 'Delete task')
    expect(duplicateItem).toBeDefined()
    expect(deleteItem).toBeDefined()

    await duplicateItem?.handler?.()
    await deleteItem?.handler?.()

    expect(host.duplicateInstance).toHaveBeenCalledWith(instance)
    expect(deleteRoutineTask).toHaveBeenCalledWith(instance)
  })

  it('falls back to non-routine delete when no history', async () => {
    const deleteNonRoutineTask = jest.fn().mockResolvedValue(undefined)
    const host = createHost({ deleteNonRoutineTask })
    const controller = new TaskContextMenuController(host)
    const instance = createInstance({
      state: 'running',
      task: { path: 'Tasks/sample.md', isRoutine: false, name: 'Sample task' },
    })

    controller.show(new MouseEvent('contextmenu'), instance)
    const menu = getMenuInstance()
    const deleteItem = menu.items.find((item) => item.title === 'Delete task')
    await deleteItem?.handler?.()
    expect(deleteNonRoutineTask).toHaveBeenCalledWith(instance)
  })
})
