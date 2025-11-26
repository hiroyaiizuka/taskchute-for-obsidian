import NavigationSectionController, { NavigationSectionHost } from '../../../src/ui/navigation/NavigationSectionController'
import RoutineManagerModal from '../../../src/features/routine/modals/RoutineManagerModal'
import { ReviewService } from '../../../src/features/review/services/ReviewService'
import { LogView } from '../../../src/features/log/views/LogView'
import NavigationSettingsController from '../../../src/ui/navigation/NavigationSettingsController'
import { Notice, TFile, WorkspaceLeaf } from 'obsidian'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

type CreateEl = (tag: string, options?: Record<string, unknown>) => HTMLElement

jest.mock('../../../src/features/routine/modals/RoutineManagerModal')
jest.mock('../../../src/features/review/services/ReviewService', () => {
  const ensureReviewFile = jest.fn().mockResolvedValue({ path: 'REVIEWS/2025-10-09.md' })
  const openInSplit = jest.fn().mockResolvedValue(undefined)
  return {
    ReviewService: jest.fn().mockImplementation(() => ({
      ensureReviewFile,
      openInSplit,
    })),
  }
})
jest.mock('../../../src/features/log/views/LogView', () => {
  return {
    LogView: jest.fn().mockImplementation(() => ({
      render: jest.fn().mockResolvedValue(undefined),
    })),
  }
})
jest.mock('../../../src/ui/navigation/NavigationSettingsController', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    openSettings: jest.fn(),
  })),
}))
jest.mock('../../../src/ui/navigation/NavigationSettingsController')

function ensurePrototypeAugmentations(): void {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: CreateEl
    empty?: () => void
  }
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const element = document.createElement(tag)
      if (options.cls) {
        element.className = options.cls as string
      }
      if (options.text) {
        element.textContent = options.text as string
      }
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          element.setAttribute(key, value)
        })
      }
      this.appendChild(element)
      return element
    }
  }
  if (!proto.empty) {
    proto.empty = function () {
      this.innerHTML = ''
    }
  }
}

const MockedRoutineManagerModal = RoutineManagerModal as jest.MockedClass<typeof RoutineManagerModal>
const MockedReviewService = ReviewService as jest.MockedClass<typeof ReviewService>
const MockedLogView = LogView as jest.MockedClass<typeof LogView>
const MockedSettingsController = NavigationSettingsController as jest.MockedClass<typeof NavigationSettingsController>
const NoticeMock = Notice as unknown as jest.Mock

describe('NavigationSectionController', () => {
  function createHost(): NavigationSectionHost & {
    closeNavigation: jest.Mock
    openNavigation: jest.Mock
    reloadTasksAndRestore: jest.Mock
    showRoutineEditModal: jest.Mock
    navigationContent: HTMLElement
  } {
    const navigationState = { selectedSection: null, isOpen: false }
    const navigationContent = document.createElement('div')
    const workspace = {
      splitActiveLeaf: jest.fn(() => ({} as WorkspaceLeaf)),
      getLeavesOfType: jest.fn(() => [] as WorkspaceLeaf[]),
      getLeaf: jest.fn(() => ({
        setViewState: jest.fn().mockResolvedValue(undefined),
        openFile: jest.fn(),
      } as unknown as WorkspaceLeaf)),
      setActiveLeaf: jest.fn(),
      revealLeaf: undefined,
    }

    const frontmatterMap = new Map<TFile, Record<string, unknown>>()
    const metadataCache = {
      getFileCache: jest.fn((file: TFile) => {
        const data = frontmatterMap.get(file)
        return data ? { frontmatter: data } : undefined
      }),
    }

    const vaultFiles: TFile[] = []
    const createFile = (path: string, frontmatter?: Record<string, unknown>) => {
      const file = new TFile()
      file.path = path
      file.basename = path.split('/').pop() ?? path
      file.extension = 'md'
      if (frontmatter) {
        frontmatterMap.set(file, frontmatter)
      }
      vaultFiles.push(file)
      return file
    }

    const host: NavigationSectionHost & {
      closeNavigation: jest.Mock
      openNavigation: jest.Mock
      reloadTasksAndRestore: jest.Mock
      showRoutineEditModal: jest.Mock
      navigationContent: HTMLElement
    } = {
      tv: jest.fn((_, fallback) => fallback),
      app: {
        setting: {
          open: jest.fn(),
          openTabById: jest.fn(),
        },
        vault: {
          getMarkdownFiles: jest.fn(() => vaultFiles),
          getAbstractFileByPath: jest.fn(() => null),
        },
        metadataCache,
        fileManager: {
          processFrontMatter: jest.fn(async (_file, updater) => {
            updater({})
          }),
          trashFile: jest.fn(),
        },
        workspace,
      },
      plugin: {
        manifest: { id: 'taskchute-plus' },
        pathManager: {
          getTaskFolderPath: () => 'TASKS',
          getProjectFolderPath: () => 'PROJECTS',
          getLogDataPath: () => 'LOGS',
          getReviewDataPath: () => 'REVIEWS',
          ensureFolderExists: jest.fn().mockResolvedValue(undefined),
          ensureYearFolder: jest.fn().mockResolvedValue('LOGS/2025'),
          validatePath: jest.fn(() => ({ valid: true })),
        },
        app: {
          vault: {
            getAbstractFileByPath: jest.fn(() => null),
          },
          fileManager: {
            trashFile: jest.fn(),
          },
          workspace,
        },
        routineAliasService: {
          loadAliases: jest.fn().mockResolvedValue({}),
        },
        dayStateService: {
          loadDay: jest.fn(),
          saveDay: jest.fn(),
          mergeDayState: jest.fn(),
          clearCache: jest.fn(),
          getDateFromKey: jest.fn(),
        },
        settings: {
          taskFolderPath: 'TASKS',
          projectFolderPath: 'PROJECTS',
          logDataPath: 'LOGS',
          reviewDataPath: 'REVIEWS',
          useOrderBasedSort: true,
        },
        saveSettings: jest.fn(),
      } as unknown as NavigationSectionHost['plugin'],
      navigationState,
      navigationContent,
      reloadTasksAndRestore: jest.fn(),
      showRoutineEditModal: jest.fn(),
      getWeekdayNames: () => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      getCurrentDateString: () => '2025-10-09',
      leaf: {} as WorkspaceLeaf,
      closeNavigation: jest.fn(),
      openNavigation: jest.fn(),
    }

    createFile('TASKS/routine.md', {
      isRoutine: true,
      routine_type: 'weekly',
      routine_interval: 1,
      routine_weekday: 1,
      routine_enabled: true,
    })
    createFile('TASKS/non.md', { isRoutine: false })

    return host
  }

  beforeEach(() => {
    jest.clearAllMocks()
    document.body.innerHTML = ''
    ensurePrototypeAugmentations()
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    ;(console.error as jest.Mock | undefined)?.mockRestore?.()
    ;(console.warn as jest.Mock | undefined)?.mockRestore?.()
  })

  test('handleNavigationItemClick opens log overlay', async () => {
    const host = createHost()
    const controller = new NavigationSectionController(host, {
      closeNavigation: host.closeNavigation,
      openNavigation: host.openNavigation,
    })

    await controller.handleNavigationItemClick('log')

    expect(MockedLogView).toHaveBeenCalledTimes(1)
    const [pluginArg, containerArg] = MockedLogView.mock.calls[0]
    expect(pluginArg).toBe(host.plugin)
    expect(containerArg).toBeInstanceOf(HTMLElement)
    expect((containerArg as HTMLElement).classList.contains('taskchute-log-modal-content')).toBe(true)
    expect(host.closeNavigation).toHaveBeenCalled()
    expect(document.querySelector('.taskchute-log-modal-overlay')).not.toBeNull()
  })

  test('handleNavigationItemClick opens project board view', async () => {
    const host = createHost()
    const controller = new NavigationSectionController(host, {
      closeNavigation: host.closeNavigation,
      openNavigation: host.openNavigation,
    })

    await controller.handleNavigationItemClick('projects')

    expect(host.app.workspace.getLeavesOfType).toHaveBeenCalledWith('taskchute-project-board')
    expect(host.app.workspace.getLeaf).toHaveBeenCalledWith(true)
    const leaf = host.app.workspace.getLeaf.mock.results[0]?.value as { setViewState: jest.Mock }
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: 'taskchute-project-board', active: true })
    expect(host.closeNavigation).toHaveBeenCalled()
  })

  test('handleNavigationItemClick triggers review service', async () => {
    const host = createHost()
    const controller = new NavigationSectionController(host, {
      closeNavigation: host.closeNavigation,
      openNavigation: host.openNavigation,
    })

    await controller.handleNavigationItemClick('review')

    expect(MockedReviewService).toHaveBeenCalledTimes(1)
    expect(MockedReviewService).toHaveBeenCalledWith(host.plugin)
    const instance = MockedReviewService.mock.results[0]?.value
    expect(instance.ensureReviewFile).toHaveBeenCalledWith('2025-10-09')
    expect(instance.openInSplit).toHaveBeenCalled()
    expect(host.closeNavigation).toHaveBeenCalled()
  })

  test('handleNavigationItemClick renders routine list when modal fails', async () => {
    const host = createHost()
    const controller = new NavigationSectionController(host, {
      closeNavigation: host.closeNavigation,
      openNavigation: host.openNavigation,
    })

    MockedRoutineManagerModal.mockImplementationOnce(() => {
      throw new Error('missing modal')
    })

    await controller.handleNavigationItemClick('routine')

    expect(host.openNavigation).toHaveBeenCalled()
    expect(host.navigationContent.querySelectorAll('.routine-row').length).toBeGreaterThan(0)
  })

  test('handleNavigationItemClick invokes settings controller', async () => {
    const host = createHost()
    const controller = new NavigationSectionController(host, {
      closeNavigation: host.closeNavigation,
      openNavigation: host.openNavigation,
    })

    await controller.handleNavigationItemClick('settings')

    const settingsInstance = MockedSettingsController.mock.results.at(-1)?.value
      ?? MockedSettingsController.mock.instances.at(-1)
    expect(settingsInstance?.openSettings).toHaveBeenCalledTimes(1)
    expect(host.closeNavigation).toHaveBeenCalled()
  })

  test('routine fallback renders interactive rows', async () => {
    const host = createHost()
    const controller = new NavigationSectionController(host, {
      closeNavigation: host.closeNavigation,
      openNavigation: host.openNavigation,
    })

    MockedRoutineManagerModal.mockImplementationOnce(() => {
      throw new Error('missing modal')
    })

    await controller.handleNavigationItemClick('routine')

    const toggle = host.navigationContent.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const editButton = host.navigationContent.querySelector<HTMLButtonElement>('.routine-edit-btn')

    expect(toggle).not.toBeNull()
    expect(editButton).not.toBeNull()
    if (!toggle || !editButton) {
      throw new Error('fallback routine row is missing expected controls')
    }

    host.reloadTasksAndRestore.mockClear()
    NoticeMock.mockClear()

    toggle.checked = !toggle.checked
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
    expect(NoticeMock).toHaveBeenCalled()

    host.showRoutineEditModal.mockClear()

    editButton.click()

    expect(host.showRoutineEditModal).toHaveBeenCalledTimes(1)
    const [taskArg, elementArg] = host.showRoutineEditModal.mock.calls[0]
    expect(taskArg?.path).toBe('TASKS/routine.md')
    expect(elementArg).toBe(editButton)
  })
})
