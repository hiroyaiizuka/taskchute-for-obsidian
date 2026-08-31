import { App, Modal } from 'obsidian'
import type { BackupEntry, BackupPreview } from '../services/BackupRestoreService'
import { getCurrentLocale } from '../../../i18n'
import { applyIcon } from '../../../ui/icons'
import { createModalFooter } from '../../../ui/components/modalFooter'

const JA_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export interface BackupRestoreModalCallbacks {
  onRestore: (monthKey: string, backupPath: string) => Promise<void>
  getPreview: (backupPath: string, targetDate?: string) => Promise<BackupPreview>
  getLatestDateInBackup?: (backupPath: string) => Promise<string | undefined>
}

export class BackupRestoreModal extends Modal {
  private selectedEntry: BackupEntry | null = null
  private restoreButton: HTMLButtonElement | null = null
  private listContainer: HTMLElement | null = null
  private messageEl: HTMLElement | null = null

  constructor(
    app: App,
    private readonly backups: Map<string, BackupEntry[]>,
    private readonly callbacks: BackupRestoreModalCallbacks,
    private readonly tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string = (_k, fb) => fb
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'backup-restore-modal')
    this.contentEl.empty()

    this.renderHeader()

    if (this.backups.size === 0) {
      this.renderEmptyState()
    } else {
      this.renderContent()
    }

    // The buttons close the dialog and act on the list above them, so they sit
    // at the bottom like every other dialog rather than beside the title.
    this.renderFooter()
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private renderHeader(): void {
    const header = this.contentEl.createDiv( { cls: 'backup-restore-header' })

    header.createEl('h2', { text: this.tv('title', 'Restore log data'), cls: 'backup-restore-title' })
  }

  private renderFooter(): void {
    const footer = this.contentEl.createDiv( { cls: 'backup-restore-footer' })

    this.messageEl = footer.createDiv( {
      cls: 'backup-restore-message',
      attr: { role: 'alert', 'aria-live': 'polite' },
    })

    createModalFooter(footer, [
      {
        text: this.tv('cancel', 'Cancel'),
        role: 'cancel',
        cls: 'backup-cancel-button',
        onClick: () => {
          this.close()
        },
      },
      // Restoring without a selection used to be blocked by a disabled button,
      // which said nothing about what was missing. It stays clickable and
      // answers instead.
      {
        text: this.tv('restoreVersion', 'Restore this version'),
        role: 'primary',
        cls: 'backup-restore-button',
        ref: (button) => {
          this.restoreButton = button
        },
        onClick: () => {
          if (!this.selectedEntry) {
            this.setMessage(this.tv('selectVersion', 'Select the version you want to restore.'))
            return
          }
          void this.showConfirmation()
        },
      },
    ])
  }

  private setMessage(message: string): void {
    if (!this.messageEl) return
    this.messageEl.textContent = message
    this.messageEl.classList.toggle('is-visible', message.length > 0)
  }

  private renderEmptyState(): void {
    const emptyState = this.contentEl.createDiv( { cls: 'backup-empty-state' })
    emptyState.createEl('p', { text: this.tv('emptyMessage', 'No backups found.') })
    emptyState.createEl('p', {
      text: this.tv('emptyHint', 'Backups are created automatically at the interval specified in settings.'),
      cls: 'backup-empty-hint',
    })
  }

  private renderContent(): void {
    const content = this.contentEl.createDiv( { cls: 'backup-restore-content' })

    // Left panel: backup list
    this.listContainer = content.createDiv( { cls: 'backup-list-panel' })
    this.renderBackupList()
  }

  private renderBackupList(): void {
    if (!this.listContainer) return

    // Flatten all entries and sort by timestamp descending
    const allEntries: BackupEntry[] = []
    for (const entries of this.backups.values()) {
      allEntries.push(...entries)
    }
    allEntries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    for (const entry of allEntries) {
      this.renderBackupEntry(this.listContainer, entry)
    }
  }

  private renderBackupEntry(container: HTMLElement, entry: BackupEntry): void {
    const entryEl = container.createDiv( { cls: 'backup-entry' })

    // Main info container
    const infoEl = entryEl.createDiv( { cls: 'backup-entry-info' })

    // Date and time as primary label
    const dateLabel = this.formatDateLabel(entry.timestamp)
    infoEl.createDiv( { text: dateLabel, cls: 'backup-entry-date' })

    // Relative time as secondary label
    infoEl.createDiv( { text: entry.label, cls: 'backup-entry-relative' })

    // Click handler
    entryEl.addEventListener('click', () => {
      this.selectEntry(entryEl, entry)
    })
  }

  private selectEntry(entryEl: HTMLElement, entry: BackupEntry): void {
    // Deselect previous
    const previouslySelected = this.contentEl.querySelector('.backup-entry.selected')
    previouslySelected?.removeClass('selected')

    // Select current
    entryEl.addClass('selected')
    this.selectedEntry = entry
    this.setMessage('')
  }

  private async showConfirmation(): Promise<void> {
    if (!this.selectedEntry) return

    try {
      // Get the latest date with data in the backup for better initial preview
      const latestDate = await this.callbacks.getLatestDateInBackup?.(this.selectedEntry.path)
      const preview = await this.callbacks.getPreview(this.selectedEntry.path, latestDate)
      const confirmed = await this.showConfirmModal(this.selectedEntry, preview)

      if (confirmed) {
        await this.callbacks.onRestore(this.selectedEntry.monthKey, this.selectedEntry.path)
        this.close()
      }
    } catch (error) {
      console.error('[BackupRestoreModal] Failed to restore', error)
    }
  }

  private showConfirmModal(entry: BackupEntry, preview: BackupPreview): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new BackupConfirmModal(
        this.app,
        entry,
        preview,
        resolve,
        this.callbacks.getPreview,
        this.tv
      )
      modal.open()
    })
  }

  private formatDateLabel(date: Date): string {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    const weekday = this.getWeekdayLabel(date.getDay())
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')

    if (getCurrentLocale() !== 'ja') {
      return `${month}/${day}/${year} (${weekday}) ${hours}:${minutes}`
    }

    return `${year}年${month}月${day}日(${weekday}) ${hours}:${minutes}`
  }

  private getWeekdayLabel(dayIndex: number): string {
    const weekdays = getCurrentLocale() === 'ja' ? JA_WEEKDAYS : EN_WEEKDAYS
    return weekdays[dayIndex] ?? ''
  }
}

class BackupConfirmModal extends Modal {
  private currentDate: string
  private currentPreview: BackupPreview
  private previewContainer: HTMLElement | null = null
  private resolved = false

  constructor(
    app: App,
    private readonly entry: BackupEntry,
    initialPreview: BackupPreview,
    private readonly resolve: (confirmed: boolean) => void,
    private readonly getPreview: (backupPath: string, targetDate?: string) => Promise<BackupPreview>,
    private readonly tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string = (_k, fb) => fb
  ) {
    super(app)
    this.currentDate = initialPreview.targetDate
    this.currentPreview = initialPreview
  }

  onOpen(): void {
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'backup-confirm-modal')
    this.contentEl.empty()

    // Header
    this.contentEl.createEl('h2', { text: this.tv('confirmTitle', 'Confirm restore'), cls: 'backup-confirm-title' })

    // Warning message
    const warningEl = this.contentEl.createDiv( { cls: 'backup-confirm-warning' })
    warningEl.createEl('p', {
      text: this.tv('confirmWarning', 'Log data for {month} will be replaced with the following backup.', { month: this.formatMonthLabel(this.entry.monthKey) }),
    })
    warningEl.createEl('p', {
      text: this.tv('confirmCaution', 'This action cannot be undone.'),
      cls: 'backup-confirm-caution',
    })

    // Backup info
    const infoEl = this.contentEl.createDiv( { cls: 'backup-confirm-info' })
    infoEl.createDiv( {
      text: this.tv('confirmBackupDate', 'Backup date: {date}', { date: this.formatDateLabel(this.entry.timestamp) }),
      cls: 'backup-confirm-date',
    })

    // Preview section container
    this.previewContainer = this.contentEl.createDiv( { cls: 'backup-preview' })
    this.renderPreview()

    const { footer } = createModalFooter(this.contentEl, [
      {
        text: this.tv('confirmCancel', 'Cancel'),
        role: 'cancel',
        cls: 'backup-cancel-button',
        onClick: () => {
          this.safeResolve(false)
          this.close()
        },
      },
      {
        text: this.tv('confirmRestore', 'Restore'),
        role: 'danger',
        cls: 'backup-confirm-button',
        onClick: () => {
          this.safeResolve(true)
          this.close()
        },
      },
    ])
    footer.classList.add('backup-confirm-buttons')
  }

  onClose(): void {
    this.contentEl.empty()
    this.safeResolve(false)
  }

  private safeResolve(value: boolean): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(value)
  }

  private renderPreview(): void {
    if (!this.previewContainer) return
    this.previewContainer.empty()

    // Header with date navigation
    const headerEl = this.previewContainer.createDiv( { cls: 'backup-preview-header' })

    // Left arrow
    const prevButton = headerEl.createEl('button', {
      cls: 'backup-preview-nav-button',
      attr: { 'aria-label': this.tv('prevDay', 'Previous day') },
    })
    applyIcon(prevButton, 'chevron-left')
    prevButton.addEventListener('click', () => {
      void this.navigateDate(-1)
    })

    // Date title
    headerEl.createEl('h3', {
      text: this.tv('previewTitle', 'Execution records for {date}', { date: this.formatDisplayDate(this.currentDate) }),
      cls: 'backup-preview-title',
    })

    // Right arrow
    const nextButton = headerEl.createEl('button', {
      cls: 'backup-preview-nav-button',
      attr: { 'aria-label': this.tv('nextDay', 'Next day') },
    })
    applyIcon(nextButton, 'chevron-right')
    nextButton.addEventListener('click', () => {
      void this.navigateDate(1)
    })

    // Execution records (scrollable)
    if (this.currentPreview.executions.length === 0) {
      this.previewContainer.createDiv( {
        text: this.tv('previewEmpty', 'No execution records.'),
        cls: 'backup-preview-empty',
      })
    } else {
      const listEl = this.previewContainer.createDiv( { cls: 'backup-preview-task-list' })

      for (const exec of this.currentPreview.executions) {
        const taskRow = listEl.createDiv( { cls: 'backup-preview-task' })

        // Time range
        taskRow.createSpan( {
          text: `${exec.startTime} - ${exec.endTime}`,
          cls: 'backup-preview-time-range',
        })

        // Task name
        taskRow.createSpan( { text: exec.taskName, cls: 'backup-preview-task-name' })
      }
    }
  }

  private async navigateDate(delta: number): Promise<void> {
    const [year, month, day] = this.currentDate.split('-').map((s) => parseInt(s, 10))
    const date = new Date(year, month - 1, day)
    date.setDate(date.getDate() + delta)

    const newDateKey = this.formatDateKey(date)

    try {
      this.currentPreview = await this.getPreview(this.entry.path, newDateKey)
      this.currentDate = newDateKey
      this.renderPreview()
    } catch (error) {
      console.error('[BackupConfirmModal] Failed to load preview', error)
    }
  }

  private formatDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  private formatDisplayDate(dateKey: string): string {
    const [year, month, day] = dateKey.split('-')
    const numericYear = parseInt(year, 10)
    const numericMonth = parseInt(month, 10)
    const numericDay = parseInt(day, 10)
    const date = new Date(numericYear, numericMonth - 1, numericDay)
    const weekdays = getCurrentLocale() === 'ja' ? JA_WEEKDAYS : EN_WEEKDAYS
    const weekday = weekdays[date.getDay()] ?? ''

    if (getCurrentLocale() !== 'ja') {
      return `${numericMonth}/${numericDay} (${weekday})`
    }

    return `${parseInt(month, 10)}月${parseInt(day, 10)}日(${weekday})`
  }

  private formatMonthLabel(monthKey: string): string {
    const [year, month] = monthKey.split('-')
    if (getCurrentLocale() !== 'ja') {
      const monthIndex = parseInt(month, 10) - 1
      const monthLabel = EN_MONTHS[monthIndex] ?? month
      return `${monthLabel} ${year}`
    }

    return `${year}年${parseInt(month, 10)}月`
  }

  private formatDateLabel(date: Date): string {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')

    if (getCurrentLocale() !== 'ja') {
      return `${month}/${day}/${year} ${hours}:${minutes}`
    }

    return `${year}年${month}月${day}日 ${hours}:${minutes}`
  }
}
