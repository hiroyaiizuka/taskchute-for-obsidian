import { App, Modal } from 'obsidian'
import type { BackupEntry, BackupPreview } from '../services/BackupRestoreService'

export interface BackupRestoreModalCallbacks {
  onRestore: (monthKey: string, backupPath: string) => Promise<void>
  getPreview: (backupPath: string, targetDate?: string) => Promise<BackupPreview>
}

export class BackupRestoreModal extends Modal {
  private selectedEntry: BackupEntry | null = null
  private restoreButton: HTMLButtonElement | null = null
  private listContainer: HTMLElement | null = null

  constructor(
    app: App,
    private readonly backups: Map<string, BackupEntry[]>,
    private readonly callbacks: BackupRestoreModalCallbacks
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('backup-restore-modal')
    this.contentEl.empty()

    // Header with title and action buttons
    this.renderHeader()

    if (this.backups.size === 0) {
      this.renderEmptyState()
    } else {
      this.renderContent()
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private renderHeader(): void {
    const header = this.contentEl.createEl('div', { cls: 'backup-restore-header' })

    header.createEl('h2', { text: 'ログデータの復元', cls: 'backup-restore-title' })

    const actions = header.createEl('div', { cls: 'backup-restore-actions' })

    // Cancel button
    const cancelButton = actions.createEl('button', {
      text: 'キャンセル',
      cls: 'backup-cancel-button',
    })
    cancelButton.addEventListener('click', () => {
      this.close()
    })

    // Restore button
    this.restoreButton = actions.createEl('button', {
      text: 'このバージョンを復元',
      cls: 'backup-restore-button',
    })
    this.restoreButton.disabled = true
    this.restoreButton.addEventListener('click', () => {
      void this.showConfirmation()
    })
  }

  private renderEmptyState(): void {
    const emptyState = this.contentEl.createEl('div', { cls: 'backup-empty-state' })
    emptyState.createEl('p', { text: 'バックアップが見つかりませんでした。' })
    emptyState.createEl('p', {
      text: 'バックアップは設定で指定した間隔で自動的に作成されます。',
      cls: 'backup-empty-hint',
    })
  }

  private renderContent(): void {
    const content = this.contentEl.createEl('div', { cls: 'backup-restore-content' })

    // Left panel: backup list
    this.listContainer = content.createEl('div', { cls: 'backup-list-panel' })
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
    const entryEl = container.createEl('div', { cls: 'backup-entry' })

    // Main info container
    const infoEl = entryEl.createEl('div', { cls: 'backup-entry-info' })

    // Date and time as primary label
    const dateLabel = this.formatDateLabel(entry.timestamp)
    infoEl.createEl('div', { text: dateLabel, cls: 'backup-entry-date' })

    // Relative time as secondary label
    infoEl.createEl('div', { text: entry.label, cls: 'backup-entry-relative' })

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

    // Enable restore button
    if (this.restoreButton) {
      this.restoreButton.disabled = false
    }
  }

  private async showConfirmation(): Promise<void> {
    if (!this.selectedEntry) return

    try {
      const preview = await this.callbacks.getPreview(this.selectedEntry.path)
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
        this.callbacks.getPreview
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

    return `${year}年${month}月${day}日(${weekday}) ${hours}:${minutes}`
  }

  private getWeekdayLabel(dayIndex: number): string {
    const weekdays = ['日', '月', '火', '水', '木', '金', '土']
    return weekdays[dayIndex] ?? ''
  }
}

class BackupConfirmModal extends Modal {
  private currentDate: string
  private currentPreview: BackupPreview
  private previewContainer: HTMLElement | null = null

  constructor(
    app: App,
    private readonly entry: BackupEntry,
    initialPreview: BackupPreview,
    private readonly resolve: (confirmed: boolean) => void,
    private readonly getPreview: (backupPath: string, targetDate?: string) => Promise<BackupPreview>
  ) {
    super(app)
    this.currentDate = initialPreview.targetDate
    this.currentPreview = initialPreview
  }

  onOpen(): void {
    this.modalEl.addClass('backup-confirm-modal')
    this.contentEl.empty()

    // Header
    this.contentEl.createEl('h2', { text: '復元の確認', cls: 'backup-confirm-title' })

    // Warning message
    const warningEl = this.contentEl.createEl('div', { cls: 'backup-confirm-warning' })
    warningEl.createEl('p', {
      text: `${this.formatMonthLabel(this.entry.monthKey)}のログデータを以下の時点でのバックアップに置き換えます。`,
    })
    warningEl.createEl('p', {
      text: 'この操作は取り消せません。',
      cls: 'backup-confirm-caution',
    })

    // Backup info
    const infoEl = this.contentEl.createEl('div', { cls: 'backup-confirm-info' })
    infoEl.createEl('div', {
      text: `バックアップ日時: ${this.formatDateLabel(this.entry.timestamp)}`,
      cls: 'backup-confirm-date',
    })

    // Preview section container
    this.previewContainer = this.contentEl.createEl('div', { cls: 'backup-preview' })
    this.renderPreview()

    // Buttons
    const buttonGroup = this.contentEl.createEl('div', { cls: 'backup-confirm-buttons' })

    const cancelButton = buttonGroup.createEl('button', {
      text: 'キャンセル',
      cls: 'backup-cancel-button',
    })
    cancelButton.addEventListener('click', () => {
      this.resolve(false)
      this.close()
    })

    const confirmButton = buttonGroup.createEl('button', {
      text: '復元する',
      cls: 'backup-confirm-button',
    })
    confirmButton.addEventListener('click', () => {
      this.resolve(true)
      this.close()
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private renderPreview(): void {
    if (!this.previewContainer) return
    this.previewContainer.empty()

    // Header with date navigation
    const headerEl = this.previewContainer.createEl('div', { cls: 'backup-preview-header' })

    // Left arrow
    const prevButton = headerEl.createEl('button', {
      text: '←',
      cls: 'backup-preview-nav-button',
      attr: { 'aria-label': '前日' },
    })
    prevButton.addEventListener('click', () => {
      void this.navigateDate(-1)
    })

    // Date title
    headerEl.createEl('h3', {
      text: `${this.formatDisplayDate(this.currentDate)} の実行記録`,
      cls: 'backup-preview-title',
    })

    // Right arrow
    const nextButton = headerEl.createEl('button', {
      text: '→',
      cls: 'backup-preview-nav-button',
      attr: { 'aria-label': '翌日' },
    })
    nextButton.addEventListener('click', () => {
      void this.navigateDate(1)
    })

    // Execution records (scrollable)
    if (this.currentPreview.executions.length === 0) {
      this.previewContainer.createEl('div', {
        text: '実行記録がありません。',
        cls: 'backup-preview-empty',
      })
    } else {
      const listEl = this.previewContainer.createEl('div', { cls: 'backup-preview-task-list' })

      for (const exec of this.currentPreview.executions) {
        const taskRow = listEl.createEl('div', { cls: 'backup-preview-task' })

        // Time range
        taskRow.createEl('span', {
          text: `${exec.startTime} - ${exec.endTime}`,
          cls: 'backup-preview-time-range',
        })

        // Task name
        taskRow.createEl('span', { text: exec.taskName, cls: 'backup-preview-task-name' })
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
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10))
    const weekdays = ['日', '月', '火', '水', '木', '金', '土']
    const weekday = weekdays[date.getDay()] ?? ''
    return `${parseInt(month, 10)}月${parseInt(day, 10)}日(${weekday})`
  }

  private formatMonthLabel(monthKey: string): string {
    const [year, month] = monthKey.split('-')
    return `${year}年${parseInt(month, 10)}月`
  }

  private formatDateLabel(date: Date): string {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')

    return `${year}年${month}月${day}日 ${hours}:${minutes}`
  }
}
