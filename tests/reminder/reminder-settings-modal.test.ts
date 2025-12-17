/**
 * @jest-environment jsdom
 */
import {
  ReminderSettingsModal,
  ReminderSettingsModalOptions,
} from '../../src/features/reminder/modals/ReminderSettingsModal';
import { t } from '../../src/i18n';

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

describe('ReminderSettingsModal', () => {
  let mockApp: unknown;
  let options: ReminderSettingsModalOptions;
  let modal: ReminderSettingsModal;
  let onSave: jest.Mock;
  let onClear: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {};
    onSave = jest.fn();
    onClear = jest.fn();

    options = {
      currentTime: undefined,
      scheduledTime: '10:00',
      defaultMinutesBefore: 5,
      onSave,
      onClear,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modal = new ReminderSettingsModal(mockApp as any, options);
  });

  describe('constructor', () => {
    it('should create modal with correct options', () => {
      expect(modal).toBeDefined();
    });
  });

  describe('onOpen', () => {
    it('should render header in modal', () => {
      modal.onOpen();
      expect(modal.contentEl.textContent).toContain(
        t('reminder.modal.title', 'Reminder settings')
      );
    });

    it('should render input field for time', () => {
      modal.onOpen();
      const input = modal.contentEl.querySelector('input[type="time"]');
      expect(input).not.toBeNull();
    });

    it('should show calculated default time when no current setting', () => {
      modal.onOpen();
      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      // scheduledTime 10:00 - 5 minutes = 09:55
      expect(input?.value).toBe('09:55');
    });

    it('should show current time when reminder is already set', () => {
      options.currentTime = '08:30';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();
      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      expect(input?.value).toBe('08:30');
    });

    it('should render save button', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const saveButton = Array.from(buttons).find(
        (btn) => btn.textContent === '設定' || btn.textContent === 'Save'
      );
      expect(saveButton).toBeDefined();
    });

    it('should render clear button when reminder is set', () => {
      options.currentTime = '09:55';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const clearButton = Array.from(buttons).find(
        (btn) => btn.textContent === '解除' || btn.textContent === 'Clear'
      );
      expect(clearButton).toBeDefined();
    });

    it('should not render clear button when no reminder is set', () => {
      options.currentTime = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const clearButton = Array.from(buttons).find(
        (btn) => btn.textContent === '解除' || btn.textContent === 'Clear'
      );
      expect(clearButton).toBeUndefined();
    });

    it('should show scheduled time info when scheduledTime is available', () => {
      modal.onOpen();
      expect(modal.contentEl.textContent).toContain('10:00');
    });
  });

  describe('button interactions', () => {
    it('should call onSave with input value when save button is clicked', () => {
      modal.onOpen();
      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      input.value = '08:45';

      const buttons = modal.contentEl.querySelectorAll('button');
      const saveButton = Array.from(buttons).find(
        (btn) => btn.textContent === '設定' || btn.textContent === 'Save'
      );
      saveButton?.click();

      expect(onSave).toHaveBeenCalledWith('08:45');
    });

    it('should close modal when save button is clicked', () => {
      modal.onOpen();
      const buttons = modal.contentEl.querySelectorAll('button');
      const saveButton = Array.from(buttons).find(
        (btn) => btn.textContent === '設定' || btn.textContent === 'Save'
      );
      saveButton?.click();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should call onClear when clear button is clicked', () => {
      options.currentTime = '09:55';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll('button');
      const clearButton = Array.from(buttons).find(
        (btn) => btn.textContent === '解除' || btn.textContent === 'Clear'
      );
      clearButton?.click();

      expect(onClear).toHaveBeenCalled();
    });

    it('should close modal when clear button is clicked', () => {
      options.currentTime = '09:55';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll('button');
      const clearButton = Array.from(buttons).find(
        (btn) => btn.textContent === '解除' || btn.textContent === 'Clear'
      );
      clearButton?.click();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should not call onSave with empty input', () => {
      modal.onOpen();
      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      input.value = '';

      const buttons = modal.contentEl.querySelectorAll('button');
      const saveButton = Array.from(buttons).find(
        (btn) => btn.textContent === '設定' || btn.textContent === 'Save'
      );
      saveButton?.click();

      expect(onSave).not.toHaveBeenCalled();
    });

    it('should not call onSave with invalid time format', () => {
      modal.onOpen();
      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      input.value = 'invalid';

      const buttons = modal.contentEl.querySelectorAll('button');
      const saveButton = Array.from(buttons).find(
        (btn) => btn.textContent === '設定' || btn.textContent === 'Save'
      );
      saveButton?.click();

      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('onClose', () => {
    it('should clean up modal content', () => {
      modal.onOpen();
      modal.onClose();
      expect(modal.contentEl.children.length).toBe(0);
    });
  });

  describe('default time calculation', () => {
    it('should calculate default time when no scheduledTime', () => {
      options.scheduledTime = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();

      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      // Without scheduledTime, should default to current time
      // We can't predict exact value, but it should be a valid time
      expect(input?.value).toMatch(/^\d{2}:\d{2}$/);
    });

    it('should handle hour rollover correctly', () => {
      options.scheduledTime = '00:03';
      options.defaultMinutesBefore = 5;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modal = new ReminderSettingsModal(mockApp as any, options);
      modal.onOpen();

      const input = modal.contentEl.querySelector(
        'input[type="time"]'
      ) as HTMLInputElement;
      // 00:03 - 5 minutes = 23:58 (previous day)
      expect(input?.value).toBe('23:58');
    });
  });
});
