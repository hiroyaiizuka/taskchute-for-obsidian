import { Notice, App } from 'obsidian'
import { getCurrentLocale } from '../../i18n'
import type { TaskChutePluginLike } from '../../types'

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
}

const TERMINAL_COMMAND_ID = 'terminal:open-terminal.integrated.root'

export default class TaskHeaderController {
  private dateLabelEl: HTMLElement | null = null

  constructor(private readonly host: TaskHeaderControllerHost) {}

  render(container: HTMLElement): void {
    this.renderDateNavigation(container)
    this.renderActionButtons(container)
  }

  refreshDateLabel(): void {
    if (this.dateLabelEl) {
      this.dateLabelEl.textContent = this.formatDateLabel()
    }
  }

  private renderDateNavigation(container: HTMLElement): void {
    const drawerToggle = container.createEl('button', {
      cls: 'drawer-toggle',
      attr: {
        title: this.host.tv('header.openNavigation', 'Open navigation'),
        'aria-label': this.host.tv('header.openNavigation', 'Open navigation'),
      },
    })
    drawerToggle.createEl('span', { cls: 'drawer-toggle-icon', text: '☰' })
    this.host.registerManagedDomEvent(drawerToggle, 'click', (event) => {
      event.stopPropagation()
      this.host.toggleNavigation()
    })

    const navContainer = container.createEl('div', {
      cls: 'date-nav-container compact',
    })

    const leftBtn = navContainer.createEl('button', {
      cls: 'date-nav-arrow',
      text: '<',
    })
    const calendarBtn = navContainer.createEl('button', {
      cls: 'calendar-btn',
      text: '🗓️',
      attr: {
        title: this.host.tv('header.openCalendar', 'Open calendar'),
        'aria-label': this.host.tv('header.openCalendar', 'Open calendar'),
      },
    })
    const dateLabel = navContainer.createEl('span', { cls: 'date-nav-label' })
    const rightBtn = navContainer.createEl('button', {
      cls: 'date-nav-arrow',
      text: '>',
    })

    this.dateLabelEl = dateLabel
    this.refreshDateLabel()

    this.host.registerManagedDomEvent(leftBtn, 'click', async (event) => {
      event.stopPropagation()
      this.host.adjustCurrentDate(-1)
      this.refreshDateLabel()
      await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
    })

    this.host.registerManagedDomEvent(rightBtn, 'click', async (event) => {
      event.stopPropagation()
      this.host.adjustCurrentDate(1)
      this.refreshDateLabel()
      await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
    })

    this.attachCalendarButton(calendarBtn)

    container.createEl('div', { cls: 'header-divider' })
  }

  private renderActionButtons(container: HTMLElement): void {
    const actionSection = container.createEl('div', {
      cls: 'header-action-section',
    })

    const addTaskButton = actionSection.createEl('button', {
      cls: 'add-task-button repositioned',
      text: '+',
      attr: {
        title: this.host.tv('header.addTask', 'Add new task'),
        'aria-label': this.host.tv('header.addTask', 'Add new task'),
      },
    })

    this.host.registerManagedDomEvent(addTaskButton, 'click', (event) => {
      event.stopPropagation()
      this.host.showAddTaskModal()
    })

    if (this.host.plugin.settings.aiRobotButtonEnabled === true) {
      const robotButton = actionSection.createEl('button', {
        cls: 'robot-terminal-button',
        text: '🤖',
        attr: {
          title: this.host.tv('header.openTerminal', 'Open terminal'),
          'aria-label': this.host.tv('header.openTerminal', 'Open terminal'),
        },
      })
      this.host.registerManagedDomEvent(robotButton, 'click', async (event) => {
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
      })
    }
  }

  private attachCalendarButton(calendarBtn: HTMLElement): void {
    this.host.registerManagedDomEvent(calendarBtn, 'click', (event) => {
      event.stopPropagation()
      const existing = document.getElementById('calendar-date-input')
      existing?.remove()

      const input = document.createElement('input')
      input.type = 'date'
      input.id = 'calendar-date-input'
      input.classList.add('taskchute-calendar-input')

      const rect = calendarBtn.getBoundingClientRect()
      input.style.setProperty('--calendar-input-left', `${rect.left}px`)
      input.style.setProperty('--calendar-input-top', `${rect.top - 900}px`)

      const currentDate = this.host.getCurrentDate()
      const y = currentDate.getFullYear()
      const m = (currentDate.getMonth() + 1).toString().padStart(2, '0')
      const d = currentDate.getDate().toString().padStart(2, '0')
      input.value = `${y}-${m}-${d}`

      document.body.appendChild(input)

      setTimeout(() => {
        try {
          input.focus()
          input.click()
          const picker = (input as HTMLInputElement & { showPicker?: () => void }).showPicker
          if (typeof picker === 'function') {
            picker.call(input)
          } else {
            const mouseEvent = new MouseEvent('mousedown', {
              view: window,
              bubbles: true,
              cancelable: true,
            })
            input.dispatchEvent(mouseEvent)
          }
        } catch {
          /* swallow focus errors */
        }
      }, 50)

      this.host.registerManagedDomEvent(input, 'change', async () => {
        const [yy, mm, dd] = input.value.split('-').map(Number)
        if (yy && mm && dd) {
          this.host.setCurrentDate(new Date(yy, mm - 1, dd))
          this.refreshDateLabel()
          await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
        }
        input.remove()
      })
      this.host.registerManagedDomEvent(input, 'blur', () => {
        input.remove()
      })
    })
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
