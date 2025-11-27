/**
 * @jest-environment jsdom
 */
 
import {
  NotificationService,
  ReminderNotificationOptions,
} from '../../src/features/reminder/services/NotificationService';

// Mock obsidian Platform
jest.mock('obsidian', () => ({
  Platform: {
    isMobile: false,
  },
}), { virtual: true });

// Mock Web Notification API
const mockNotificationInstance = {
  close: jest.fn(),
  onclick: null as ((event: Event) => void) | null,
};

const mockNotificationConstructor = jest.fn(() => mockNotificationInstance);

// Store original Notification
const originalNotification = global.Notification;

describe('NotificationService', () => {
  let service: NotificationService;
  let mockShowBuiltinReminder: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockShowBuiltinReminder = jest.fn();
    mockNotificationInstance.onclick = null;

    // Setup Web Notification API mock with permission granted
    const mockNotification = mockNotificationConstructor as unknown as typeof Notification;
    Object.defineProperty(mockNotification, 'permission', {
      get: () => 'granted',
      configurable: true,
    });
    mockNotification.requestPermission = jest.fn().mockResolvedValue('granted');
    global.Notification = mockNotification;
  });

  afterEach(() => {
    // Restore original Notification
    global.Notification = originalNotification;
  });

  describe('isMobile', () => {
    it('should return false when Platform.isMobile is false', () => {
      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });

      expect(service.isMobile()).toBe(false);
    });
  });

  describe('notify (fallback)', () => {
    beforeEach(() => {
      // Remove Notification API to simulate unsupported environment
      // @ts-expect-error - intentionally removing for test
      delete global.Notification;

      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });
    });

    it('should call showBuiltinReminder when notifications not supported', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      service.notify(options);

      expect(mockShowBuiltinReminder).toHaveBeenCalledWith(options);
    });
  });

  describe('notify (desktop with Web Notifications)', () => {
    beforeEach(() => {
      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });
    });

    it('should create Web notification on desktop', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      service.notify(options);

      expect(mockNotificationConstructor).toHaveBeenCalledWith(
        'TaskChute Plus',
        {
          body: 'Test Task - まもなく開始 (09:00)',
          tag: '/tasks/test.md',
        }
      );
    });

    it('should set onclick handler on notification', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      service.notify(options);

      expect(mockNotificationInstance.onclick).toBeDefined();
    });

    it('should show builtin reminder when notification is clicked', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      service.notify(options);

      // Simulate click by calling onclick
      if (mockNotificationInstance.onclick) {
        mockNotificationInstance.onclick(new Event('click'));
      }

      expect(mockNotificationInstance.close).toHaveBeenCalled();
      expect(mockShowBuiltinReminder).toHaveBeenCalledWith(options);
    });

    it('should include task name in notification body', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Important Meeting',
        scheduledTime: '14:30',
        taskPath: '/tasks/meeting.md',
      };

      service.notify(options);

      expect(mockNotificationConstructor).toHaveBeenCalledWith(
        'TaskChute Plus',
        expect.objectContaining({
          body: expect.stringContaining('Important Meeting'),
        })
      );
    });

    it('should include scheduled time in notification body', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '15:45',
        taskPath: '/tasks/test.md',
      };

      service.notify(options);

      expect(mockNotificationConstructor).toHaveBeenCalledWith(
        'TaskChute Plus',
        expect.objectContaining({
          body: expect.stringContaining('15:45'),
        })
      );
    });

    it('should call onNotificationDisplayed callback after showing notification', () => {
      const mockOnDisplayed = jest.fn();
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
        onNotificationDisplayed: mockOnDisplayed,
      };

      service.notify(options);

      expect(mockOnDisplayed).toHaveBeenCalled();
    });
  });

  describe('notify (permission denied)', () => {
    beforeEach(() => {
      // Setup with permission denied
      const mockNotification = mockNotificationConstructor as unknown as typeof Notification;
      Object.defineProperty(mockNotification, 'permission', {
        get: () => 'denied',
        configurable: true,
      });
      global.Notification = mockNotification;

      service = new NotificationService({
        showBuiltinReminder: mockShowBuiltinReminder,
      });
    });

    it('should fall back to builtin reminder when permission denied', () => {
      const options: ReminderNotificationOptions = {
        taskName: 'Test Task',
        scheduledTime: '09:00',
        taskPath: '/tasks/test.md',
      };

      service.notify(options);

      expect(mockShowBuiltinReminder).toHaveBeenCalledWith(options);
      expect(mockNotificationConstructor).not.toHaveBeenCalled();
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
