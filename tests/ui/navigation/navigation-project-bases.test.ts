import { Notice, TFile, type WorkspaceLeaf } from 'obsidian'
import NavigationSectionController, { type NavigationSectionHost } from '@/ui/navigation/NavigationSectionController'
import { ensureProjectBase, isBasesKanbanSupported } from '@/features/project/services/ProjectBasesKanban'

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), Notice: jest.fn() }))
jest.mock('@/features/project/services/ProjectBasesKanban', () => ({
  ensureProjectBase: jest.fn(),
  isBasesKanbanSupported: jest.fn(() => true),
}))
jest.mock('@/ui/navigation/NavigationSettingsController')

const ensure = ensureProjectBase as jest.Mock
const supported = isBasesKanbanSupported as jest.Mock

function setUp(options: { view?: 'board' | 'bases'; folder?: string | null; openedViewType?: string; open?: WorkspaceLeaf[] } = {}) {
  const base = new TFile()
  base.path = 'Projects/TaskChute Projects.base'
  ensure.mockResolvedValue(base)
  const opened = {
    openFile: jest.fn(async () => undefined),
    detach: jest.fn(),
    setViewState: jest.fn().mockResolvedValue(undefined),
    view: { getViewType: () => options.openedViewType ?? 'bases', file: base },
  }
  const workspace = {
    getLeavesOfType: jest.fn((type: string) => (type === 'bases' ? options.open ?? [] : [])),
    getLeaf: jest.fn(() => opened),
    revealLeaf: jest.fn(async () => undefined),
    setActiveLeaf: jest.fn(),
  }
  const host = {
    tv: (_key: string, fallback: string) => fallback,
    app: { workspace },
    plugin: {
      manifest: { id: 'taskchute-plus' },
      settings: { projectBoardView: options.view ?? 'bases' },
      pathManager: { getProjectFolderPath: () => (options.folder === undefined ? 'Projects' : options.folder) },
    },
    navigationState: { selectedSection: null, isOpen: true },
    getWeekdayNames: () => [],
    getCurrentDateString: () => '2026-10-17',
    leaf: {} as WorkspaceLeaf,
  } as unknown as NavigationSectionHost
  const closeNavigation = jest.fn()
  const controller = new NavigationSectionController(host, { closeNavigation, openNavigation: jest.fn() })
  return { controller, workspace, opened, base, closeNavigation }
}

describe('"Projects" as a Bases kanban', () => {
  beforeEach(() => {
    ensure.mockReset()
    supported.mockReturnValue(true)
    ;(Notice as unknown as jest.Mock).mockClear()
  })

  test('opens the projects base when the Bases kanban is chosen', async () => {
    const { controller, opened, base, workspace, closeNavigation } = setUp()
    await controller.handleNavigationItemClick('projects')
    expect(ensure).toHaveBeenCalledWith(expect.anything(), 'Projects', 'Projects')
    expect(opened.openFile).toHaveBeenCalledWith(base)
    expect(workspace.revealLeaf).toHaveBeenCalledWith(opened)
    expect(opened.setViewState).not.toHaveBeenCalled()
    expect(closeNavigation).toHaveBeenCalled()
  })

  test('an already open base is brought forward instead of opened twice', async () => {
    const already = { view: { getViewType: () => 'bases', file: { path: 'Projects/TaskChute Projects.base' } } } as unknown as WorkspaceLeaf
    const { controller, workspace, opened } = setUp({ open: [already] })
    await controller.handleNavigationItemClick('projects')
    expect(workspace.revealLeaf).toHaveBeenCalledWith(already)
    expect(opened.openFile).not.toHaveBeenCalled()
  })

  test.each([
    ['the TaskChute board is chosen', { view: 'board' as const }],
    ['the project folder is not set', { folder: null }],
  ])('opens the TaskChute board when %s', async (_why, options) => {
    const { controller, opened } = setUp(options)
    await controller.handleNavigationItemClick('projects')
    expect(ensure).not.toHaveBeenCalled()
    expect(opened.setViewState).toHaveBeenCalledWith({ type: 'taskchute-project-board', active: true })
  })

  test('before Obsidian 1.14 a saved Bases choice falls back to the TaskChute board', async () => {
    supported.mockReturnValue(false)
    const { controller, opened } = setUp()
    await controller.handleNavigationItemClick('projects')
    expect(ensure).not.toHaveBeenCalled()
    expect(opened.setViewState).toHaveBeenCalledWith({ type: 'taskchute-project-board', active: true })
  })

  test('with the Bases core plugin off, it says so and shows the TaskChute board', async () => {
    const { controller, opened } = setUp({ openedViewType: 'empty' })
    await controller.handleNavigationItemClick('projects')
    expect(opened.detach).toHaveBeenCalled()
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Bases core plugin'))
    expect(opened.setViewState).toHaveBeenCalledWith({ type: 'taskchute-project-board', active: true })
  })
})
