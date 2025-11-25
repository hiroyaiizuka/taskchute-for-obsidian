/**
 * @jest-environment jsdom
 */
import {
  NotificationService,
  ReminderNotificationOptions,
} from '../../src/features/reminder/services/NotificationService';

// Mock Electron
const mockNotificationInstance = {
  on: jest.fn(),
  show: jest.fn(),
  close: jest.fn(),
};

const mockNotificationConstructor = jest.fn(() => mockNotificationInstance);

const mockElectron = {
  remote: {
    Notification: mockNotificationConstructor,
  },
};

describe('NotificationService', () => {
  let service: NotificationService;
  let mockShowBuiltinReminder: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockShowBuiltinReminder = jest.fn();

    // Reset window.require mock
    (window as { require?: unknown }).require = undefined;
  });

  describe('isMobile', () => {
    it('should return true when electron is not available', () => {
      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });

      expect(service.isMobile()).toBe(true);
    });

    it('should return false when electron is available', () => {
      // Mock window.require to return electron
      (window as { require?: (module: string) => unknown }).require = (module: string) => {
        if (module === 'electron') return mockElectron;
        return undefined;
      };

      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });

      expect(service.isMobile()).toBe(false);
    });
  });

  describe('notify (mobile/fallback)', () => {
    beforeEach(() => {
      // No electron available (mobile)
      (window as { require?: unknown }).require = undefined;
      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });
    });

    it('should call showBuiltinReminder on mobile', async () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      await service.notify(options);

      expect(mockShowBuiltinReminder).toHaveBeenCalledWith(options);
    });
  });

  describe('notify (desktop)', () => {
    beforeEach(() => {
      // Mock window.require to return electron
      (window as { require?: (module: string) => unknown }).require = (module: string) => {
        if (module === 'electron') return mockElectron;
        return undefined;
      };

      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });
    });

    it('should create Electron notification on desktop', async () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      await service.notify(options);

      expect(mockNotificationConstructor).toHaveBeenCalledWith({
        title: 'TaskChute Plus',
        body: 'Test Task - まもなく開始 (09:00)',
      });
      expect(mockNotificationInstance.show).toHaveBeenCalled();
    });

    it('should register click handler on notification', async () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      await service.notify(options);

      expect(mockNotificationInstance.on).toHaveBeenCalledWith(
        'click',
        expect.any(Function)
      );
    });

    it('should show builtin reminder when notification is clicked', async () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      await service.notify(options);

      // Get the click handler
      const clickHandler = mockNotificationInstance.on.mock.calls.find(
        (call: [string, () => void]) => call[0] === 'click'
      )?.[1];

      // Simulate click
      clickHandler?.();

      expect(mockNotificationInstance.close).toHaveBeenCalled();
      expect(mockShowBuiltinReminder).toHaveBeenCalledWith(options);
    });

    it('should include task name in notification body', async () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Important Meeting',
        scheduledTime: '14:30',
        taskPath: '/tasks/meeting.md',
      };

      await service.notify(options);

      expect(mockNotificationConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Important Meeting'),
        })
      );
    });

    it('should include scheduled time in notification body', async () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '15:45',
        taskPath: '/tasks/test.md',
      };

      await service.notify(options);

      expect(mockNotificationConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('15:45'),
        })
      );
    });
  });

  describe('formatNotificationBody', () => {
    beforeEach(() => {
      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });
    });

    it('should format notification body correctly', () => {
      const body = service.formatNotificationBody('Test Task', '09:00');
      expect(body).toBe('Test Task - まもなく開始 (09:00)');
    });
  });
});
