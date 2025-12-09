import { App } from 'obsidian'
import { BackupRestoreModal, BackupRestoreModalCallbacks } from '../../../src/features/log/modals/BackupRestoreModal'
import type { BackupEntry, BackupPreview } from '../../../src/features/log/services/BackupRestoreService'

// Add Obsidian-specific methods to HTMLElement
function addObsidianMethods(el: HTMLElement): void {
  (el as HTMLElement & { addClass: (cls: string) => void }).addClass = function (cls: string) {
    this.classList.add(cls)
  };
  (el as HTMLElement & { removeClass: (cls: string) => void }).removeClass = function (cls: string) {
    this.classList.remove(cls)
  };
  (el as HTMLElement & { empty: () => void }).empty = function () {
    this.innerHTML = ''
  };
  (el as HTMLElement & { createEl: (tag: string, options?: { text?: string; cls?: string }) => HTMLElement }).createEl =
    function (tag: string, options?: { text?: string; cls?: string }): HTMLElement {
      const child = document.createElement(tag)
      addObsidianMethods(child)
      if (options?.text) child.textContent = options.text
      if (options?.cls) child.classList.add(options.cls)
      this.appendChild(child)
      return child
    }
}

jest.mock('obsidian', () => {
  class MockApp {}
  class Modal {
    app: MockApp
    modalEl: HTMLElement
    contentEl: HTMLElement

    constructor(app: MockApp) {
      this.app = app
      this.modalEl = document.createElement('div')
      this.contentEl = document.createElement('div')
      addObsidianMethods(this.modalEl)
      addObsidianMethods(this.contentEl)
      this.modalEl.appendChild(this.contentEl)
    }

    open(): void {
      document.body.appendChild(this.modalEl)
      const maybeOnOpen = (this as unknown as { onOpen?: () => void }).onOpen
      if (typeof maybeOnOpen === 'function') {
        maybeOnOpen.call(this)
      }
    }

    close(): void {
      const maybeOnClose = (this as unknown as { onClose?: () => void }).onClose
      if (typeof maybeOnClose === 'function') {
        maybeOnClose.call(this)
      }
      if (this.modalEl.parentElement) {
        this.modalEl.parentElement.removeChild(this.modalEl)
      }
    }
  }

  return {
    App: MockApp,
    Modal,
    Notice: jest.fn(),
  }
})

function createMockBackups(): Map<string, BackupEntry[]> {
  const now = new Date()
  const backups = new Map<string, BackupEntry[]>()

  backups.set('2025-12', [
    {
      path: 'LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json',
      timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      label: '2時間前',
      monthKey: '2025-12',
    },
    {
      path: 'LOGS/backups/2025-12/2025-12-08T08-00-00-000Z.json',
      timestamp: new Date(now.getTime() - 4 * 60 * 60 * 1000),
      label: '4時間前',
      monthKey: '2025-12',
    },
  ])

  backups.set('2025-11', [
    {
      path: 'LOGS/backups/2025-11/2025-11-30T10-00-00-000Z.json',
      timestamp: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      label: '8日前',
      monthKey: '2025-11',
    },
  ])

  return backups
}

function createMockPreview(targetDate = '2025-12-08'): BackupPreview {
  const previewData: Record<string, BackupPreview> = {
    '2025-12-08': {
      targetDate: '2025-12-08',
      executions: [
        { taskName: 'メール対応', startTime: '09:00', endTime: '09:30' },
        { taskName: 'ミーティング', startTime: '10:00', endTime: '11:00' },
        { taskName: 'レビュー作業', startTime: '11:30', endTime: '12:00' },
        { taskName: '資料作成', startTime: '14:00', endTime: '15:30' },
        { taskName: '報告書作成', startTime: '16:00', endTime: '-' },
      ],
    },
    '2025-12-07': {
      targetDate: '2025-12-07',
      executions: [
        { taskName: '昨日のタスク1', startTime: '10:00', endTime: '11:00' },
        { taskName: '昨日のタスク2', startTime: '14:00', endTime: '15:00' },
      ],
    },
    '2025-12-09': {
      targetDate: '2025-12-09',
      executions: [],
    },
  }
  return previewData[targetDate] ?? { targetDate, executions: [] }
}

function createMockCallbacks(overrides?: Partial<BackupRestoreModalCallbacks>): BackupRestoreModalCallbacks {
  return {
    onRestore: jest.fn().mockResolvedValue(undefined),
    getPreview: jest.fn().mockImplementation((_path: string, targetDate?: string) => {
      return Promise.resolve(createMockPreview(targetDate ?? '2025-12-08'))
    }),
    ...overrides,
  }
}

describe('BackupRestoreModal', () => {
  let modal: BackupRestoreModal
  let callbacks: BackupRestoreModalCallbacks

  beforeEach(() => {
    document.body.innerHTML = ''
    callbacks = createMockCallbacks()
    modal = new BackupRestoreModal(new App(), createMockBackups(), callbacks)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('rendering', () => {
    test('renders modal title', () => {
      modal.open()

      const title = document.querySelector('.backup-restore-modal h2')
      expect(title?.textContent).toMatch(/復元|Restore/i)
    })

    test('renders backup entries as flat list', () => {
      modal.open()

      const entries = document.querySelectorAll('.backup-entry')
      expect(entries.length).toBe(3) // 2 for Dec + 1 for Nov
    })

    test('displays relative time labels', () => {
      modal.open()

      const labels = document.querySelectorAll('.backup-entry .backup-entry-relative')
      const labelTexts = Array.from(labels).map((el) => el.textContent)

      expect(labelTexts).toContain('2時間前')
      expect(labelTexts).toContain('4時間前')
      expect(labelTexts).toContain('8日前')
    })

    test('displays date labels with weekday', () => {
      modal.open()

      const dateLabels = document.querySelectorAll('.backup-entry .backup-entry-date')
      expect(dateLabels.length).toBe(3)
      // Each date label should contain year, month, day, weekday and time
      const firstLabel = dateLabels[0]?.textContent ?? ''
      expect(firstLabel).toMatch(/\d{4}年\d{1,2}月\d{1,2}日\(.+\) \d{2}:\d{2}/)
    })

    test('shows empty state when no backups', () => {
      modal = new BackupRestoreModal(new App(), new Map(), callbacks)
      modal.open()

      const emptyMessage = document.querySelector('.backup-empty-state')
      expect(emptyMessage).toBeTruthy()
    })
  })

  describe('selection', () => {
    test('clicking backup entry selects it', () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      expect(firstEntry?.classList.contains('selected')).toBe(true)
    })

    test('selecting new entry deselects previous', () => {
      modal.open()

      const entries = document.querySelectorAll<HTMLElement>('.backup-entry')
      entries[0]?.click()
      entries[1]?.click()

      expect(entries[0]?.classList.contains('selected')).toBe(false)
      expect(entries[1]?.classList.contains('selected')).toBe(true)
    })

    test('restore button is disabled when no selection', () => {
      modal.open()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      expect(restoreButton?.disabled).toBe(true)
    })

    test('restore button is enabled when entry selected', () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      expect(restoreButton?.disabled).toBe(false)
    })
  })

  describe('confirmation flow', () => {
    test('clicking restore button opens confirmation modal', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      // Wait for async preview fetch
      await new Promise((resolve) => setTimeout(resolve, 10))

      const confirmModal = document.querySelector('.backup-confirm-modal')
      expect(confirmModal).toBeTruthy()
    })

    test('confirmation modal shows preview data with execution records', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      // Check task list is rendered
      const taskList = document.querySelector('.backup-preview-task-list')
      expect(taskList).toBeTruthy()

      // Check tasks are displayed
      const tasks = document.querySelectorAll('.backup-preview-task')
      expect(tasks.length).toBe(5)

      // Check time ranges are displayed
      const timeRanges = document.querySelectorAll('.backup-preview-time-range')
      expect(timeRanges.length).toBe(5)
      expect(timeRanges[0]?.textContent).toBe('09:00 - 09:30')
      expect(timeRanges[4]?.textContent).toBe('16:00 - -')
    })

    test('clicking cancel on confirmation modal closes it without restore', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      const cancelButton = document.querySelector('.backup-confirm-modal .backup-cancel-button') as HTMLButtonElement
      cancelButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(callbacks.onRestore).not.toHaveBeenCalled()
    })

    test('clicking confirm on confirmation modal calls onRestore callback', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      const confirmButton = document.querySelector('.backup-confirm-modal .backup-confirm-button') as HTMLButtonElement
      confirmButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(callbacks.onRestore).toHaveBeenCalledWith(
        '2025-12',
        'LOGS/backups/2025-12/2025-12-08T10-00-00-000Z.json'
      )
    })

    test('modal closes after successful restore confirmation', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      const confirmButton = document.querySelector('.backup-confirm-modal .backup-confirm-button') as HTMLButtonElement
      confirmButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(document.querySelector('.backup-restore-modal')).toBeNull()
    })
  })

  describe('cancel button', () => {
    test('clicking cancel button closes modal without restore', () => {
      modal.open()

      const cancelButton = document.querySelector('.backup-cancel-button') as HTMLButtonElement
      cancelButton?.click()

      expect(callbacks.onRestore).not.toHaveBeenCalled()
      expect(document.querySelector('.backup-restore-modal')).toBeNull()
    })
  })

  describe('date navigation', () => {
    test('confirmation modal shows navigation buttons', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      const navButtons = document.querySelectorAll('.backup-preview-nav-button')
      expect(navButtons.length).toBe(2)
    })

    test('clicking left arrow navigates to previous day', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      // Verify initial date
      let title = document.querySelector('.backup-preview-title')
      expect(title?.textContent).toContain('12月8日')

      // Click left arrow (previous day)
      const prevButton = document.querySelectorAll('.backup-preview-nav-button')[0] as HTMLButtonElement
      prevButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      // Verify date changed to Dec 7
      title = document.querySelector('.backup-preview-title')
      expect(title?.textContent).toContain('12月7日')

      // Verify tasks updated
      const tasks = document.querySelectorAll('.backup-preview-task')
      expect(tasks.length).toBe(2)
      expect(tasks[0]?.textContent).toContain('昨日のタスク1')
    })

    test('clicking right arrow navigates to next day', async () => {
      modal.open()

      const firstEntry = document.querySelector('.backup-entry') as HTMLElement
      firstEntry?.click()

      const restoreButton = document.querySelector('.backup-restore-button') as HTMLButtonElement
      restoreButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      // Click right arrow (next day)
      const nextButton = document.querySelectorAll('.backup-preview-nav-button')[1] as HTMLButtonElement
      nextButton?.click()

      await new Promise((resolve) => setTimeout(resolve, 10))

      // Verify date changed to Dec 9
      const title = document.querySelector('.backup-preview-title')
      expect(title?.textContent).toContain('12月9日')

      // Verify empty state shown (no executions on Dec 9)
      const emptyMessage = document.querySelector('.backup-preview-empty')
      expect(emptyMessage).toBeTruthy()
    })
  })

})
