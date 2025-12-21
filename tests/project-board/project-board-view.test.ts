import { WorkspaceLeaf, TFile } from 'obsidian'

import ProjectBoardView from '../../src/ui/project/ProjectBoardView'
import type { TaskChutePluginLike, ProjectBoardItem } from '../../src/types'
import type { ProjectBoardService } from '../../src/services/projects'
import { ProjectBoardStatus } from '../../src/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  class MockNotice {
    constructor(public message: string) {}
  }

  return {
    ...actual,
    Notice: jest.fn((message: string) => new MockNotice(message)),
    TFile: class MockTFile {
      path = ''
      basename = ''
      extension = 'md'
    },
  }
})

describe('ProjectBoardView', () => {
  type MutableView = ProjectBoardView & {
    items: ProjectBoardItem[]
    statusDefs: Array<{ id: ProjectBoardStatus; label: string }>
    render: () => void
  }

  const flushMicrotasks = () => new Promise<void>((resolve) => {
    void Promise.resolve().then(() => resolve())
  })

  function createPluginStub(options: {
    items?: ProjectBoardItem[]
    createProjectResult?: ProjectBoardItem
    loadProjectItems?: () => ProjectBoardItem[]
  }) {
    const items = options.items ?? []

    const loadProjectItems = jest.fn(options.loadProjectItems ?? (() => items))
    const createProject = jest.fn(async () =>
      options.createProjectResult ?? items[0] ?? createItem('todo', 'New project'),
    )
    const updateProjectStatus = jest.fn(async () => {})
    const service = {
      loadProjectItems,
      createProject,
      updateProjectStatus,
    } as unknown as ProjectBoardService

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(),
        },
        workspace: {
          splitActiveLeaf: jest.fn(() => ({ openFile: jest.fn(), setViewState: jest.fn() })),
          getLeaf: jest.fn(() => ({ setViewState: jest.fn(), openFile: jest.fn() })),
          setActiveLeaf: jest.fn(),
        },
        i18n: {
          translate: jest.fn((key: string) => key),
        },
      },
      settings: {
        projectsFolder: 'Projects',
      },
      pathManager: {
        getProjectFolderPath: () => 'Projects',
      },
    } as unknown as TaskChutePluginLike

    return { plugin, service }
  }

  function attachCreateEl(element: HTMLElement): void {
    const typed = element as HTMLElement & {
      createEl?: (tag: string, options?: Record<string, unknown>) => HTMLElement
      addClass?: (cls: string) => void
      empty?: () => void
    }
    typed.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const node = document.createElement(tag)
      if (options.cls) node.className = options.cls as string
      if (options.text) node.textContent = options.text as string
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          node.setAttribute(key, value)
        })
      }
      attachCreateEl(node)
      this.appendChild(node)
      return node
    }
    typed.addClass = function (this: HTMLElement, cls: string) {
      this.classList.add(cls)
    }
    typed.empty = function (this: HTMLElement) {
      this.textContent = ''
    }
  }

  function createItem(status: ProjectBoardStatus, title: string): ProjectBoardItem {
    const file = new TFile()
    file.path = `Projects/${title}.md`
    file.basename = title
    return {
      file,
      path: file.path,
      basename: file.basename,
      title,
      displayTitle: title,
      status,
      order: null,
      frontmatter: {},
    }
  }

  function createView(options: {
    items?: ProjectBoardItem[]
    createProjectResult?: ProjectBoardItem
    loadProjectItems?: () => ProjectBoardItem[]
  }) {
    const { plugin, service } = createPluginStub(options)
    const leaf = { containerEl: document.createElement('div') } as unknown as WorkspaceLeaf
    const view = new ProjectBoardView(leaf, plugin, {
      boardService: service,
    })
    view.containerEl = document.createElement('div')
    attachCreateEl(view.containerEl)
    view.app = plugin.app
    return { view, plugin, service }
  }

  test('renders status columns and project cards', () => {
    const items = [
      createItem('todo', 'Alpha'),
      createItem('in-progress', 'Beta'),
      createItem('done', 'Gamma'),
    ]

    const { view } = createView({ items })
    const mutable = view as MutableView
    mutable.items = items
    mutable.statusDefs = [
      { id: 'todo', label: 'To Do' },
      { id: 'in-progress', label: 'In Progress' },
      { id: 'done', label: 'Done' },
    ]

    mutable.render()

    expect(view.containerEl.querySelectorAll('.project-board-column').length).toBe(3)
    expect(view.containerEl.querySelectorAll('.project-board-card').length).toBe(3)
  })

  test('always shows all status columns without menu button', () => {
    const items = [createItem('todo', 'Alpha'), createItem('in-progress', 'Beta')]
    const { view } = createView({ items })
    const mutable = view as MutableView
    mutable.items = items
    mutable.statusDefs = [
      { id: 'todo', label: 'To Do' },
      { id: 'in-progress', label: 'In Progress' },
      { id: 'done', label: 'Done' },
    ]

    mutable.render()

    expect(view.containerEl.querySelectorAll('.project-board-column[data-status="todo"]').length).toBe(1)
    expect(view.containerEl.querySelectorAll('.project-board-column[data-status="in-progress"]').length).toBe(1)
    expect(view.containerEl.querySelectorAll('.project-board-column[data-status="done"]').length).toBe(1)
    expect(view.containerEl.querySelector('.project-board-button--menu')).toBeNull()
  })

  test('limits cards per column until load more is clicked', () => {
    const items = Array.from({ length: 12 }, (_, index) => createItem('todo', `Project ${index + 1}`))
    const { view } = createView({ items })
    const mutable = view as MutableView
    mutable.items = items
    mutable.statusDefs = [
      { id: 'todo', label: 'To Do' },
      { id: 'in-progress', label: 'In Progress' },
      { id: 'done', label: 'Done' },
    ]

    mutable.render()

    const todoColumn = view.containerEl.querySelector('.project-board-column[data-status="todo"]') as HTMLElement
    const renderedCards = todoColumn.querySelectorAll('.project-board-card')
    expect(renderedCards.length).toBe(10)

    const loadMore = todoColumn.querySelector('.project-board-column__load-more') as HTMLButtonElement
    expect(loadMore).not.toBeNull()

    loadMore.click()

    const cardsAfter = view.containerEl.querySelectorAll('.project-board-column[data-status="todo"] .project-board-card')
    expect(cardsAfter.length).toBe(12)
    expect(view.containerEl.querySelector('.project-board-column__load-more')).toBeNull()
  })

  test('reserves fixed-height body and scrollable card regions', () => {
    const items = Array.from({ length: 15 }, (_, index) => createItem('in-progress', `Project ${index + 1}`))
    const { view } = createView({ items })
    const mutable = view as MutableView
    mutable.items = items
    mutable.statusDefs = [
      { id: 'todo', label: 'To Do' },
      { id: 'in-progress', label: 'In Progress' },
      { id: 'done', label: 'Done' },
    ]

    mutable.render()

    const body = view.containerEl.querySelector('.project-board-view__body') as HTMLElement
    expect(body).not.toBeNull()
    expect(body?.getAttribute('data-layout')).toBe('fixed')

    const columns = Array.from(view.containerEl.querySelectorAll('.project-board-column__cards'))
    expect(columns.length).toBeGreaterThan(0)
    columns.forEach((list) => {
      expect(list.getAttribute('data-scroll-region')).toBe('cards')
    })
  })

  test('creates project in selected column without relying on metadata cache', async () => {
    const createdItem = createItem('in-progress', 'New project')
    const loadProjectItems = jest.fn(() => [createItem('todo', 'New project')])
    const { view, service } = createView({
      items: [],
      createProjectResult: createdItem,
      loadProjectItems,
    })
    const mutable = view as MutableView
    mutable.items = []
    mutable.statusDefs = [
      { id: 'todo', label: 'To Do' },
      { id: 'in-progress', label: 'In Progress' },
      { id: 'done', label: 'Done' },
    ]

    const scheduleMetadataRefresh = jest.fn()
    ;(view as unknown as { scheduleMetadataRefresh: jest.Mock }).scheduleMetadataRefresh = scheduleMetadataRefresh

    mutable.render()

    const addButton = view.containerEl.querySelector(
      '.project-board-column[data-status="in-progress"] .project-board-column__new',
    ) as HTMLButtonElement
    expect(addButton).not.toBeNull()
    addButton.click()

    const overlay = document.querySelector('.task-modal-overlay') as HTMLElement
    const form = overlay.querySelector('form') as HTMLFormElement
    const input = overlay.querySelector('input') as HTMLInputElement
    input.value = 'New project'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await flushMicrotasks()

    expect((service as unknown as { createProject: jest.Mock }).createProject).toHaveBeenCalledWith({
      title: 'New project',
      status: 'in-progress',
    })

    const inProgressCards = view.containerEl.querySelectorAll(
      '.project-board-column[data-status="in-progress"] .project-board-card',
    )
    const todoCards = view.containerEl.querySelectorAll(
      '.project-board-column[data-status="todo"] .project-board-card',
    )
    expect(inProgressCards.length).toBe(1)
    expect(inProgressCards[0].textContent).toBe('New project')
    expect(todoCards.length).toBe(0)
    expect(scheduleMetadataRefresh).toHaveBeenCalledWith(createdItem.path, 'in-progress')
  })

  describe('reloadItemsPreservingState', () => {
    type ReloadableView = ProjectBoardView & {
      items: ProjectBoardItem[]
      optimisticItems: Map<string, { status: ProjectBoardStatus; order: number; updated: string; completed?: string }>
      reloadItemsPreservingState: () => boolean
    }

    function createItemWithOrder(
      status: ProjectBoardStatus,
      title: string,
      order: number | null,
    ): ProjectBoardItem {
      const file = new TFile()
      file.path = `Projects/${title}.md`
      file.basename = title
      return {
        file,
        path: file.path,
        basename: file.basename,
        title,
        displayTitle: title,
        status,
        order,
        frontmatter: { status, order },
      }
    }

    test('preserves optimistic order when status matches but order differs', () => {
      // Scenario: User drags project E before project D within same status column
      // - Initial state: items have order [1000, 2000, 3000, 4000, 5000] (A, B, C, D, E)
      // - User drags E to position before D
      // - optimisticItems stores new order for E (e.g., 3500)
      // - metadataCache hasn't updated yet, so loadProjectItems returns old order (5000)
      // - reloadItemsPreservingState should preserve the optimistic order (3500)

      const itemA = createItemWithOrder('in-progress', 'A', 1000)
      const itemB = createItemWithOrder('in-progress', 'B', 2000)
      const itemC = createItemWithOrder('in-progress', 'C', 3000)
      const itemD = createItemWithOrder('in-progress', 'D', 4000)
      const itemE = createItemWithOrder('in-progress', 'E', 5000)

      const initialItems = [itemA, itemB, itemC, itemD, itemE]

      // Service returns items with OLD order (metadataCache not yet updated)
      const loadProjectItems = jest.fn(() => [
        createItemWithOrder('in-progress', 'A', 1000),
        createItemWithOrder('in-progress', 'B', 2000),
        createItemWithOrder('in-progress', 'C', 3000),
        createItemWithOrder('in-progress', 'D', 4000),
        createItemWithOrder('in-progress', 'E', 5000), // Still old order
      ])

      const service = {
        loadProjectItems,
        createProject: jest.fn(),
        updateProjectStatus: jest.fn(),
      } as unknown as ProjectBoardService

      const plugin = {
        app: {
          vault: { getAbstractFileByPath: jest.fn() },
          workspace: {
            splitActiveLeaf: jest.fn(),
            getLeaf: jest.fn(),
            setActiveLeaf: jest.fn(),
          },
          i18n: { translate: jest.fn((key: string) => key) },
        },
        settings: { projectsFolder: 'Projects' },
        pathManager: { getProjectFolderPath: () => 'Projects' },
      } as unknown as TaskChutePluginLike

      const leaf = { containerEl: document.createElement('div') } as unknown as WorkspaceLeaf
      const view = new ProjectBoardView(leaf, plugin, { boardService: service }) as ReloadableView

      // Set initial items
      view.items = initialItems

      // Simulate optimistic update: E moved to order 3500 (between C and D)
      const newOrderForE = 3500
      view.optimisticItems.set(itemE.path, {
        status: 'in-progress', // Same status
        order: newOrderForE,
        updated: new Date().toISOString(),
      })

      // Call reloadItemsPreservingState
      view.reloadItemsPreservingState()

      // Find item E in the reloaded items
      const reloadedE = view.items.find((item) => item.title === 'E')

      // The order should be preserved from optimisticItems, not the old metadataCache value
      expect(reloadedE?.order).toBe(newOrderForE)
    })

    test('clears optimisticItems only when both status and order match', () => {
      // When metadataCache catches up (both status AND order match), optimisticItems should be cleared

      const itemE = createItemWithOrder('in-progress', 'E', 3500)

      // Service returns item with UPDATED order (metadataCache has caught up)
      const loadProjectItems = jest.fn(() => [createItemWithOrder('in-progress', 'E', 3500)])

      const service = {
        loadProjectItems,
        createProject: jest.fn(),
        updateProjectStatus: jest.fn(),
      } as unknown as ProjectBoardService

      const plugin = {
        app: {
          vault: { getAbstractFileByPath: jest.fn() },
          workspace: {
            splitActiveLeaf: jest.fn(),
            getLeaf: jest.fn(),
            setActiveLeaf: jest.fn(),
          },
          i18n: { translate: jest.fn((key: string) => key) },
        },
        settings: { projectsFolder: 'Projects' },
        pathManager: { getProjectFolderPath: () => 'Projects' },
      } as unknown as TaskChutePluginLike

      const leaf = { containerEl: document.createElement('div') } as unknown as WorkspaceLeaf
      const view = new ProjectBoardView(leaf, plugin, { boardService: service }) as ReloadableView

      view.items = [itemE]

      // Optimistic state matches what metadataCache will return
      view.optimisticItems.set(itemE.path, {
        status: 'in-progress',
        order: 3500,
        updated: new Date().toISOString(),
      })

      view.reloadItemsPreservingState()

      // optimisticItems should be cleared since metadataCache has caught up
      expect(view.optimisticItems.has(itemE.path)).toBe(false)
    })
  })
})
