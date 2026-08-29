import NavigationSectionController, {
  NavigationSection,
  NavigationSectionHost,
} from './NavigationSectionController'
import NavigationLogController from './NavigationLogController'
import NavigationReviewController from './NavigationReviewController'
import NavigationRoutineController from './NavigationRoutineController'

interface NavigationItem {
  key: NavigationSection
  label: string
  icon: string
}

export interface NavigationControllerOptions {
  logController?: NavigationLogController
  reviewController?: NavigationReviewController
  routineController?: NavigationRoutineController
}

interface NavigationControllerHost extends NavigationSectionHost {
  registerManagedDomEvent: (target: HTMLElement, event: string, handler: EventListener) => void
  navigationOverlay?: HTMLElement
  navigationPanel?: HTMLElement
  navigationContent?: HTMLElement
}

export default class NavigationController {
  private readonly sectionController: NavigationSectionController
  private navMenu?: HTMLElement

  constructor(
    private readonly view: NavigationControllerHost,
    options: NavigationControllerOptions = {},
  ) {
    this.sectionController = new NavigationSectionController(
      this.view,
      {
        closeNavigation: () => this.closeNavigation(),
        openNavigation: () => this.openNavigation(),
      },
      {
        logController: options.logController,
        reviewController: options.reviewController,
        routineController: options.routineController,
      },
    )
  }

  private bindDomEvent(element: HTMLElement | null | undefined, event: string, handler: EventListener): void {
    if (!element) return
    if (typeof this.view.registerManagedDomEvent === 'function') {
      this.view.registerManagedDomEvent(element, event, handler)
    } else {
      element.addEventListener(event, handler)
    }
  }

  createNavigationUI(contentContainer: HTMLElement): void {
    const overlay = contentContainer.createDiv( {
      cls: 'navigation-overlay navigation-overlay-hidden',
    })
    const panel = contentContainer.createDiv( {
      cls: 'navigation-panel navigation-panel-hidden',
    })
    const navMenu = panel.createEl('nav', { cls: 'navigation-nav' })
    const navContent = panel.createDiv( { cls: 'navigation-content' })
    this.navMenu = navMenu

    this.view.navigationOverlay = overlay
    this.view.navigationPanel = panel
    this.view.navigationContent = navContent

    this.renderNavigationItems(navMenu)
  }

  refreshNavigationItems(): void {
    if (!this.navMenu) return
    while (this.navMenu.firstChild) {
      this.navMenu.removeChild(this.navMenu.firstChild)
    }
    this.renderNavigationItems(this.navMenu)
  }

  private isRecipeFeatureEnabled(): boolean {
    return this.view.plugin.settings.recipeFeatureEnabled === true
  }

  private renderNavigationItems(navMenu: HTMLElement): void {
    const items: NavigationItem[] = [
      { key: 'routine', label: this.view.tv('navigation.routine', 'ルーチン'), icon: '🔄' },
      { key: 'review', label: this.view.tv('navigation.review', 'デビュー'), icon: '📋' },
      { key: 'log', label: this.view.tv('navigation.log', 'ログ'), icon: '📊' },
      ...(this.isRecipeFeatureEnabled()
        ? [{ key: 'recipes' as const, label: this.view.tv('navigation.recipes', 'レシピ'), icon: '📄' }]
        : []),
      { key: 'projects', label: this.view.tv('navigation.projects', 'プロジェクト'), icon: '📁' },
      { key: 'settings', label: this.view.tv('navigation.settings', '設定'), icon: '⚙️' },
    ]

    items.forEach((item) => {
      const navItem = navMenu.createDiv( {
        cls: 'navigation-nav-item',
        attr: { 'data-section': item.key },
      })
      navItem.createSpan( { cls: 'navigation-nav-icon', text: item.icon })
      navItem.createSpan( { cls: 'navigation-nav-label', text: item.label })
      this.bindDomEvent(navItem, 'click', () => {
        void this.handleNavigationItemClick(item.key)
      })
    })
  }

  initializeNavigationEventListeners(): void {
    this.bindDomEvent(this.view.navigationOverlay, 'click', () => {
      this.closeNavigation()
    })
  }

  toggleNavigation(): void {
    this.view.navigationState.isOpen = !this.view.navigationState.isOpen
    if (this.view.navigationState.isOpen) {
      this.openNavigation()
    } else {
      this.closeNavigation()
    }
  }

  openNavigation(): void {
    this.view.navigationPanel?.classList.remove('navigation-panel-hidden')
    this.view.navigationOverlay?.classList.remove('navigation-overlay-hidden')
  }

  closeNavigation(): void {
    this.view.navigationPanel?.classList.add('navigation-panel-hidden')
    this.view.navigationOverlay?.classList.add('navigation-overlay-hidden')
  }

  async handleNavigationItemClick(section: NavigationSection): Promise<void> {
    await this.sectionController.handleNavigationItemClick(section)
  }

  renderRoutineList(): void {
    this.sectionController.renderRoutineList()
  }

}
