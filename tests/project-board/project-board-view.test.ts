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

  function createPluginStub(options: { items?: ProjectBoardItem[] }) {
    const items = options.items ?? []

    const loadProjectItems = jest.fn(() => items)
    const createProject = jest.fn(async () => items[0] ?? createItem('todo', 'New project'))
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

  function createView(options: { items?: ProjectBoardItem[] }) {
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
})
