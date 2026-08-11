/**
 * @jest-environment jsdom
 */
import {
  ReminderNotificationModal,
  ReminderNotificationModalOptions,
} from '../../src/features/reminder/modals/ReminderNotificationModal';

// Mock Obsidian App and Modal
const mockOpen = jest.fn();
const mockClose = jest.fn();

jest.mock('obsidian', () => ({
  Modal: class MockModal {
    app: unknown;
    contentEl: HTMLElement;
    modalEl: HTMLElement;

    constructor(app: unknown) {
      this.app = app;
      this.contentEl = document.createElement('div');
      this.modalEl = document.createElement('div');
    }

    open = mockOpen;
    close = mockClose;
  },
}));

describe('ReminderNotificationModal', () => {
  let mockApp: { workspace: { openLinkText: jest.Mock } };
  let modal: ReminderNotificationModal;
  let options: ReminderNotificationModalOptions;
  let onClose: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {
      workspace: {
        openLinkText: jest.fn(),
      },
    };
    onClose = jest.fn();
    options = {
      taskName: 'Test Task',
      scheduledTime: '09:00',
      taskPath: '/tasks/test.md',
      onClose,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modal = new ReminderNotificationModal(mockApp as any, options);
  });

  describe('constructor', () => {
    it('should create modal with correct options', () => {
      expect(modal).toBeDefined();
      expect(modal.getTaskName()).toBe('Test Task');
      expect(modal.getScheduledTime()).toBe('09:00');
      expect(modal.getTaskPath()).toBe('/tasks/test.md');
    });
  });

  describe('onOpen', () => {
    it('should render task name in modal', () => {
      modal.onOpen();
      expect(modal.contentEl.textContent).toContain('Test Task');
    });

    it('should render scheduled time in modal', () => {
      modal.onOpen();
      expect(modal.contentEl.textContent).toContain('09:00');
    });

    it('should render reminder message in modal', () => {
      modal.onOpen();
      expect(modal.contentEl.textContent).toContain('まもなく開始');
    });

    it('should render "Open File" button', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const openFileButton = Array.from(buttons).find(
        (btn) => btn.textContent === 'ファイルを開く'
      );
      expect(openFileButton).toBeDefined();
    });

    it('should render "Close" button', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const closeButton = Array.from(buttons).find(
        (btn) => btn.textContent === '閉じる'
      );
      expect(closeButton).toBeDefined();
    });

    it('should add CSS class to modal', () => {
      modal.onOpen();
      expect(modal.modalEl.classList.contains('taskchute-reminder-modal')).toBe(
        true
      );
    });
  });

  describe('button interactions', () => {
    it('should open task file when "Open File" button is clicked', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const openFileButton = Array.from(buttons).find(
        (btn) => btn.textContent === 'ファイルを開く'
      );

      openFileButton?.click();

      expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith(
        '/tasks/test.md',
        '',
        false
      );
    });

    it('should close modal when "Open File" button is clicked', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const openFileButton = Array.from(buttons).find(
        (btn) => btn.textContent === 'ファイルを開く'
      );

      openFileButton?.click();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should close modal when "Close" button is clicked', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const closeButton = Array.from(buttons).find(
        (btn) => btn.textContent === '閉じる'
      );

      closeButton?.click();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should call onClose callback when modal is closed', () => {
      modal.onOpen();
      modal.onClose();

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('onClose', () => {
    it('should clean up modal content', () => {
      modal.onOpen();
      modal.onClose();

      // Content should be cleared
      expect(modal.contentEl.children.length).toBe(0);
    });

    it('should remove CSS class from modal', () => {
      modal.onOpen();
      modal.onClose();

      expect(
        modal.modalEl.classList.contains('taskchute-reminder-modal')
      ).toBe(false);
    });
  });
});

describe('Notification queue management', () => {
  it('should track beingDisplayed state', () => {
    const mockApp = {
      workspace: {
        openLinkText: jest.fn(),
      },
    };
    const onClose = jest.fn();
    const options: ReminderNotificationModalOptions = {
      taskName: 'Test Task',
      scheduledTime: '09:00',
      taskPath: '/tasks/test.md',
      onClose,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modal = new ReminderNotificationModal(mockApp as any, options);

    // Modal starts as not displayed
    expect(modal.isBeingDisplayed()).toBe(false);

    // After open, it should be displayed
    modal.onOpen();
    expect(modal.isBeingDisplayed()).toBe(true);

    // After close, it should not be displayed
    modal.onClose();
    expect(modal.isBeingDisplayed()).toBe(false);
  });
});
