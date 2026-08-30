import { Notice, App, setIcon } from 'obsidian'
import { applyIcon, createIconSpan } from '../icons'
import TaskMoveCalendar, {
  TaskMoveCalendarFactory,
  TaskMoveCalendarHandle,
} from '../components/TaskMoveCalendar'
import { getCurrentLocale } from '../../i18n'
import type { TaskChutePluginLike } from '../../types'
import type { AiTaskBoardView } from '../../features/ai-task/types'

export interface TaskHeaderControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getCurrentDate: () => Date
  setCurrentDate: (next: Date) => void
  adjustCurrentDate: (days: number) => void
  reloadTasksAndRestore: (options?: { runBoundaryCheck?: boolean }) => Promise<void> | void
  showAddTaskModal: () => void
  toggleNavigation: () => void
  plugin: TaskChutePluginLike
  app: Pick<App, 'commands'>
  registerManagedDomEvent: (target: Document | HTMLElement, event: string, handler: EventListener) => void
  registerDisposer?: (cleanup: () => void) => void
  /**
   * AI board view switch (all three optional so hosts without the AI Task
   * feature render the header exactly as before): the segmented control is
   * drawn only while isAiTaskFeatureEnabled() reports true.
   */
  isAiTaskFeatureEnabled?: () => boolean
  getAiTaskBoardView?: () => AiTaskBoardView
  setAiTaskBoardView?: (view: AiTaskBoardView) => void
}

const TERMINAL_COMMAND_ID = 'terminal:open-terminal.integrated.root'

/**
 * Segment definitions of the approved A board-view switch. Lucide icons are
 * composed in code so i18n strings stay plain sentence-case labels.
 */
const BOARD_VIEW_SEGMENTS: ReadonlyArray<{
  view: AiTaskBoardView
  icon: string
  labelKey: string
  labelFallback: string
  ariaKey: string
  ariaFallback: string
}> = [
  {
    view: 'human',
    icon: 'user-round',
    labelKey: 'aiTask.boardView.human',
    labelFallback: 'Human',
    ariaKey: 'aiTask.boardView.humanAria',
    ariaFallback: 'Show human tasks only',
  },
  {
    view: 'ai',
    icon: 'bot',
    labelKey: 'aiTask.boardView.ai',
    labelFallback: 'AI',
    ariaKey: 'aiTask.boardView.aiAria',
    ariaFallback: 'Show AI tasks only',
  },
  {
    view: 'mixed',
    icon: 'layers',
    labelKey: 'aiTask.boardView.mixed',
    labelFallback: 'Mixed',
    ariaKey: 'aiTask.boardView.mixedAria',
    ariaFallback: 'Show all tasks',
  },
]

export interface TaskHeaderControllerDependencies {
  createCalendar: TaskMoveCalendarFactory
}

const defaultDependencies: TaskHeaderControllerDependencies = {
  createCalendar: (options) => new TaskMoveCalendar(options),
}

export default class TaskHeaderController {
  private dateLabelEl: HTMLElement | null = null
  private navContainerEl: HTMLElement | null = null
  private activeCalendar: TaskMoveCalendarHandle | null = null
  private actionSectionEl: HTMLElement | null = null
  private boardViewSwitchEl: HTMLElement | null = null
  private boardViewButtons = new Map<AiTaskBoardView, HTMLButtonElement>()

  constructor(
    private readonly host: TaskHeaderControllerHost,
    private readonly dependencies: TaskHeaderControllerDependencies = defaultDependencies,
  ) {
    this.host.registerDisposer?.(() => this.closeActiveCalendar())
  }

  render(container: HTMLElement): void {
    this.renderDateNavigation(container)
    this.renderActionButtons(container)
  }

  refreshDateLabel(): void {
    if (this.dateLabelEl) {
      this.dateLabelEl.textContent = this.formatDateLabel()
    }
    // 今日以外の日付を見ているという状態をクラスとして出しておく（日付ラベルの
    // 幅は固定なので、レイアウトの補正には使っていない）
    if (this.navContainerEl) {
      const isToday = this.isCurrentDateToday()
      this.navContainerEl.classList.toggle('is-not-today', !isToday)
    }
  }

  private isCurrentDateToday(): boolean {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const current = this.host.getCurrentDate()
    const normalized = new Date(current.getFullYear(), current.getMonth(), current.getDate())
    return today.getTime() === normalized.getTime()
  }

  private renderDateNavigation(container: HTMLElement): void {
    const drawerToggle = container.createEl('button', {
      cls: 'drawer-toggle',
      attr: {
        title: this.host.tv('header.openNavigation', 'Open navigation'),
        'aria-label': this.host.tv('header.openNavigation', 'Open navigation'),
      },
    })
    createIconSpan(drawerToggle, 'menu', 'drawer-toggle-icon')
    this.host.registerManagedDomEvent(drawerToggle, 'click', (event) => {
      event.stopPropagation()
      this.host.toggleNavigation()
    })

    const navContainer = container.createDiv( {
      cls: 'date-nav-container compact',
    })
    this.navContainerEl = navContainer

    const leftBtn = navContainer.createEl('button', {
      cls: 'date-nav-arrow',
      attr: {
        title: this.host.tv('header.previousDay', 'Previous day'),
        'aria-label': this.host.tv('header.previousDay', 'Previous day'),
      },
    })
    applyIcon(leftBtn, 'chevron-left')
    const calendarBtn = navContainer.createEl('button', {
      cls: 'calendar-btn',
      text: '🗓️',
      attr: {
        title: this.host.tv('header.openCalendar', 'Open calendar'),
        'aria-label': this.host.tv('header.openCalendar', 'Open calendar'),
      },
    })
    const dateLabel = navContainer.createSpan( { cls: 'date-nav-label' })
    const rightBtn = navContainer.createEl('button', {
      cls: 'date-nav-arrow',
      attr: {
        title: this.host.tv('header.nextDay', 'Next day'),
        'aria-label': this.host.tv('header.nextDay', 'Next day'),
      },
    })
    applyIcon(rightBtn, 'chevron-right')

    this.dateLabelEl = dateLabel
    this.refreshDateLabel()

    this.host.registerManagedDomEvent(leftBtn, 'click', (event) => {
      void (async () => {
        event.stopPropagation()
        this.host.adjustCurrentDate(-1)
        this.refreshDateLabel()
        await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      })()
    })

    this.host.registerManagedDomEvent(rightBtn, 'click', (event) => {
      void (async () => {
        event.stopPropagation()
        this.host.adjustCurrentDate(1)
        this.refreshDateLabel()
        await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      })()
    })

    this.attachCalendarButton(calendarBtn)

    container.createDiv( { cls: 'header-divider' })
  }

  private renderActionButtons(container: HTMLElement): void {
    const actionSection = container.createDiv( {
      cls: 'header-action-section',
    })
    this.actionSectionEl = actionSection

    if (this.host.plugin.settings.aiRobotButtonEnabled === true) {
      const robotButton = actionSection.createEl('button', {
        cls: 'robot-terminal-button',
        text: '🤖',
        attr: {
          title: this.host.tv('header.openTerminal', 'Open terminal'),
          'aria-label': this.host.tv('header.openTerminal', 'Open terminal'),
        },
      })
      this.host.registerManagedDomEvent(robotButton, 'click', (event) => {
        void (async () => {
          event.stopPropagation()
          const commandsApi = this.host.app.commands as unknown as {
            executeCommandById?: (id: string) => boolean | void | Promise<void>
            commands?: Record<string, unknown>
          }
          const commandExists = Boolean(commandsApi.commands?.[TERMINAL_COMMAND_ID])
          if (!commandExists) {
            new Notice(
              this.host.tv('header.terminalPluginMissing', 'Terminal plugin not found. Please install it.'),
            )
            return
          }
          try {
            const result = commandsApi.executeCommandById?.(TERMINAL_COMMAND_ID)
            if (result instanceof Promise) {
              await result
            }
          } catch (error) {
            const message = this.host.tv(
              'header.terminalOpenFailed',
              'Failed to open terminal: {message}',
              { message: error instanceof Error ? error.message : String(error) },
            )
            new Notice(message)
          }
        })()
      })
    }

    // Keep the view switch immediately beside the primary add action.
    // Optional legacy actions stay before this pair.
    this.renderAiTaskBoardSwitch(actionSection)

    const addTaskButton = actionSection.createEl('button', {
      cls: 'add-task-button repositioned',
      attr: {
        title: this.host.tv('header.addTask', 'Add new task'),
        'aria-label': this.host.tv('header.addTask', 'Add new task'),
      },
    })
    applyIcon(addTaskButton, 'plus')

    this.host.registerManagedDomEvent(addTaskButton, 'click', (event) => {
      event.stopPropagation()
      this.host.showAddTaskModal()
    })
  }

  /**
   * Attach (or detach) the 3-way board view switch immediately before the
   * add-task action. Nothing renders while the AI Task feature is disabled or
   * the host lacks the callbacks — the header then matches its pre-feature
   * markup exactly. The control (and its managed click handlers) is built
   * ONCE and cached: refreshes only reattach it, because managed
   * registrations are released at view unload only, and re-registering fresh
   * buttons on every feature toggle would accumulate handlers for detached
   * nodes across the session.
   */
  private renderAiTaskBoardSwitch(actionSection: HTMLElement): void {
    if (
      this.host.isAiTaskFeatureEnabled?.() !== true ||
      !this.host.getAiTaskBoardView ||
      !this.host.setAiTaskBoardView
    ) {
      this.boardViewSwitchEl?.remove()
      return
    }

    const group = this.boardViewSwitchEl ?? this.createBoardViewSwitch(actionSection)
    const addTaskButton = Array.from(actionSection.children).find((child) =>
      child.classList.contains('add-task-button'),
    ) ?? null
    // A refresh can reattach the cached control after the add button already
    // exists. Inserting immediately before it keeps the pair adjacent while
    // leaving optional legacy actions at the start of the action section.
    if (
      group.parentElement !== actionSection ||
      group.nextElementSibling !== addTaskButton
    ) {
      actionSection.insertBefore(group, addTaskButton)
    }
    this.refreshBoardViewActiveState()
  }

  /** Build the segmented control and register its handlers exactly once */
  private createBoardViewSwitch(section: HTMLElement): HTMLElement {
    const group = section.createDiv( {
      cls: 'ai-board-view-switch',
      attr: {
        role: 'group',
        'aria-label': this.host.tv('aiTask.boardView.label', 'Board view'),
      },
    })

    for (const segment of BOARD_VIEW_SEGMENTS) {
      const label = this.host.tv(segment.labelKey, segment.labelFallback)
      const aria = this.host.tv(segment.ariaKey, segment.ariaFallback)
      const button = group.createEl('button', {
        cls: 'ai-board-view-switch__segment',
        attr: {
          'aria-label': aria,
          title: aria,
          'data-view': segment.view,
          'aria-pressed': 'false',
        },
      })
      const icon = button.createSpan({
        cls: 'ai-board-view-switch__icon',
        attr: {
          'aria-hidden': 'true',
          'data-icon': segment.icon,
        },
      })
      setIcon(icon, segment.icon)
      button.createSpan({
        cls: 'ai-board-view-switch__label',
        text: label,
      })
      this.host.registerManagedDomEvent(button, 'click', (event) => {
        event.stopPropagation()
        this.host.setAiTaskBoardView?.(segment.view)
        this.refreshBoardViewActiveState()
      })
      this.boardViewButtons.set(segment.view, button)
    }
    this.boardViewSwitchEl = group
    return group
  }

  /** Mirror host.getAiTaskBoardView() onto the segment active states */
  private refreshBoardViewActiveState(): void {
    const current = this.host.getAiTaskBoardView?.() ?? 'mixed'
    for (const [view, button] of this.boardViewButtons) {
      const isActive = view === current
      button.classList.toggle('is-active', isActive)
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false')
    }
  }

  /**
   * Re-sync the switch with the feature toggle without re-rendering the
   * whole header (called when the AI Task settings change at runtime).
   */
  public refreshAiTaskBoardSwitch(): void {
    if (!this.actionSectionEl) return
    this.renderAiTaskBoardSwitch(this.actionSectionEl)
  }

  private attachCalendarButton(calendarBtn: HTMLElement): void {
    this.host.registerManagedDomEvent(calendarBtn, 'click', (event) => {
      event.stopPropagation()
      this.openCalendar(calendarBtn)
    })
  }

  private openCalendar(anchor: HTMLElement): void {
    if (this.activeCalendar) {
      this.closeActiveCalendar()
    }

    const calendar = this.dependencies.createCalendar({
      anchor,
      initialDate: this.host.getCurrentDate(),
      today: new Date(),
      onSelect: async (isoDate) => {
        const nextDate = this.parseIsoDate(isoDate)
        if (!nextDate) {
          return
        }
        this.host.setCurrentDate(nextDate)
        this.refreshDateLabel()
        await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      },
      onClose: () => {
        if (this.activeCalendar === calendar) {
          this.activeCalendar = null
        }
      },
      registerDisposer: this.host.registerDisposer
        ? (cleanup) => this.host.registerDisposer?.(cleanup)
        : undefined,
    })

    this.activeCalendar = calendar
    calendar.open()
  }

  private closeActiveCalendar(): void {
    if (this.activeCalendar) {
      this.activeCalendar.close()
      this.activeCalendar = null
    }
  }

  private parseIsoDate(value: string): Date | null {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
    if (!match) {
      return null
    }
    const [, year, month, day] = match
    const parsed = Date.parse(`${year}-${month}-${day}T00:00:00`)
    if (Number.isNaN(parsed)) {
      return null
    }
    const date = new Date(parsed)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
  }

  private formatDateLabel(): string {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const current = this.host.getCurrentDate()
    const normalized = new Date(current.getFullYear(), current.getMonth(), current.getDate())
    const isToday = today.getTime() === normalized.getTime()
    const localeCode = getCurrentLocale() === 'ja' ? 'ja-JP' : 'en-US'
    const dayName = normalized.toLocaleDateString(localeCode, { weekday: 'short' })
    const dateStr = `${normalized.getMonth() + 1}/${normalized.getDate()}`
    const todayLabel = this.host.tv('date.today', 'Today')
    return isToday ? `${todayLabel} (${dateStr} ${dayName})` : `${dateStr} ${dayName}`
  }
}
