import { App, Notice, WorkspaceLeaf } from 'obsidian'
import type { TaskChutePluginLike } from '../../types'
import RoutineManagerModal from '../../features/routine/modals/RoutineManagerModal'
import NavigationLogController from './NavigationLogController'
import NavigationReviewController from './NavigationReviewController'
import NavigationRoutineController from './NavigationRoutineController'
import NavigationSettingsController from './NavigationSettingsController'
import { VIEW_TYPE_PROJECT_BOARD } from '../../types'
import type { RoutineTaskShape } from '../../types/Routine'

export interface NavigationSectionHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: App
  plugin: TaskChutePluginLike
  navigationState: { selectedSection: NavigationSection | null; isOpen: boolean }
  navigationContent?: HTMLElement
  reloadTasksAndRestore?: (options?: { runBoundaryCheck?: boolean }) => Promise<void> | void
  showRoutineEditModal?: (task: RoutineTaskShape, element?: HTMLElement) => void
  getWeekdayNames: () => string[]
  getCurrentDateString: () => string
  leaf: WorkspaceLeaf
}

export type NavigationSection = 'routine' | 'projects' | 'review' | 'log' | 'settings'

interface NavigationCallbacks {
  closeNavigation: () => void
  openNavigation: () => void
}

interface NavigationSectionDependencies {
  logController?: NavigationLogController
  reviewController?: NavigationReviewController
  routineController?: NavigationRoutineController
  settingsController?: NavigationSettingsController
}

export default class NavigationSectionController {
  private readonly logController: NavigationLogController
  private readonly reviewController: NavigationReviewController
  private readonly routineController: NavigationRoutineController
  private readonly settingsController: NavigationSettingsController

  constructor(
    private readonly host: NavigationSectionHost,
    private readonly callbacks: NavigationCallbacks,
    dependencies: NavigationSectionDependencies = {},
  ) {
    this.logController =
      dependencies.logController ??
      new NavigationLogController({
        plugin: this.host.plugin,
        leaf: this.host.leaf,
        navigationState: this.host.navigationState,
      })
    this.reviewController =
      dependencies.reviewController ??
      new NavigationReviewController({
        app: this.host.app,
        plugin: this.host.plugin,
        leaf: this.host.leaf,
        navigationState: this.host.navigationState,
        getCurrentDateString: this.host.getCurrentDateString
          ? () => this.host.getCurrentDateString()
          : undefined,
      })
    this.routineController =
      dependencies.routineController ??
      new NavigationRoutineController({
        tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
        app: this.host.app,
        plugin: this.host.plugin,
        navigationContent: this.host.navigationContent,
        reloadTasksAndRestore: this.host.reloadTasksAndRestore,
        showRoutineEditModal: this.host.showRoutineEditModal,
        getWeekdayNames: () => this.host.getWeekdayNames(),
      })
    this.settingsController =
      dependencies.settingsController ??
      new NavigationSettingsController({
        app: this.host.app,
        pluginId: this.host.plugin.manifest?.id ?? 'taskchute-plus',
        notifyFailure: (message) => new Notice(this.host.tv('settings.openFailed', message)),
      })
  }

  async handleNavigationItemClick(section: NavigationSection): Promise<void> {
    if (section === 'projects') {
      await this.openProjectBoard()
      this.callbacks.closeNavigation()
      return
    }
    if (section === 'log') {
      this.logController.openLogModal()
      this.callbacks.closeNavigation()
      return
    }
    if (section === 'review') {
      await this.reviewController.showReviewSection()
      this.callbacks.closeNavigation()
      return
    }
    if (section === 'routine') {
      try {
        new RoutineManagerModal(this.host.app, this.host.plugin).open()
      } catch (error) {
        console.error('[Navigation] Failed to open RoutineManagerModal:', error)
        await this.renderRoutineList()
        this.callbacks.openNavigation()
      }
      this.callbacks.closeNavigation()
      return
    }
    if (section === 'settings') {
      this.settingsController.openSettings()
      this.callbacks.closeNavigation()
      return
    }
    const label = this.host.tv(`navigation.${section}`, section)
    new Notice(this.host.tv('notices.sectionWip', '{section} is under construction', { section: label }))
  }

  renderRoutineList(): void {
    this.routineController.renderRoutineList()
  }

  private openProjectBoard(): void {
    const workspace = this.host.app.workspace
    const existing = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_BOARD)
    const leaf = existing.length > 0 ? existing[0] : workspace.getLeaf(true)
    if (!leaf) {
      console.error('[Navigation] No workspace leaf available')
      new Notice(
        this.host.tv('projectBoard.errors.genericTitle', 'Unable to load projects'),
      )
      return
    }
    void leaf.setViewState({ type: VIEW_TYPE_PROJECT_BOARD, active: true }).then(() => {
      if (typeof workspace.revealLeaf === 'function') {
        void workspace.revealLeaf(leaf)
      } else {
        workspace.setActiveLeaf(leaf)
      }
    }).catch((error: unknown) => {
      console.error('[Navigation] Failed to open project board view:', error)
      new Notice(
        this.host.tv('projectBoard.errors.genericTitle', 'Unable to load projects'),
      )
    })
  }

}
