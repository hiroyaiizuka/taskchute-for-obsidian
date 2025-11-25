/**
 * @jest-environment jsdom
 */
import {
  ReminderIconRenderer,
  ReminderIconRendererOptions,
} from '../../src/features/reminder/ui/ReminderIconRenderer';
import type { TaskInstance } from '../../src/types';

// Mock Obsidian's createEl and createSvg
const mockCreateEl = function (
  this: HTMLElement,
  tagName: string,
  options?: { cls?: string; text?: string; attr?: Record<string, string> }
): HTMLElement {
  const el = document.createElement(tagName);
  if (options?.cls) {
    el.className = options.cls;
  }
  if (options?.text) {
    el.textContent = options.text;
  }
  if (options?.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      el.setAttribute(key, value);
    });
  }
  this.appendChild(el);
  (el as HTMLElement & { createEl: typeof mockCreateEl }).createEl = mockCreateEl;
  (el as HTMLElement & { createSvg: typeof mockCreateSvg }).createSvg = mockCreateSvg;
  return el;
};

const mockCreateSvg = function (
  this: HTMLElement | SVGElement,
  tagName: string,
  options?: { cls?: string; attr?: Record<string, string> }
): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  if (options?.cls) {
    el.setAttribute('class', options.cls);
  }
  if (options?.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      el.setAttribute(key, value);
    });
  }
  this.appendChild(el);
  (el as SVGElement & { createSvg: typeof mockCreateSvg }).createSvg = mockCreateSvg;
  return el;
};

beforeAll(() => {
  (HTMLElement.prototype as HTMLElement & { createEl: typeof mockCreateEl }).createEl =
    mockCreateEl;
  (HTMLElement.prototype as HTMLElement & { createSvg: typeof mockCreateSvg }).createSvg =
    mockCreateSvg;
});

describe('ReminderIconRenderer', () => {
  let renderer: ReminderIconRenderer;
  let options: ReminderIconRendererOptions;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    (container as HTMLElement & { createEl: typeof mockCreateEl }).createEl = mockCreateEl;
    (container as HTMLElement & { createSvg: typeof mockCreateSvg }).createSvg = mockCreateSvg;

    options = {
      tv: jest.fn((key: string, fallback: string) => fallback),
    };
    renderer = new ReminderIconRenderer(options);
  });

  describe('render', () => {
    it('should render reminder icon when reminder_time is set', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '09:00',
          reminder_time: '08:55',
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const icon = container.querySelector('.reminder-icon');
      expect(icon).not.toBeNull();
    });

    it('should not render reminder icon when reminder_time is not set', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '09:00',
          reminder_time: undefined,
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const icon = container.querySelector('.reminder-icon');
      expect(icon).toBeNull();
    });

    it('should not render reminder icon when reminder_time is empty string', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '09:00',
          reminder_time: '',
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const icon = container.querySelector('.reminder-icon');
      expect(icon).toBeNull();
    });

    it('should render clock SVG icon', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '09:00',
          reminder_time: '08:55',
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const svg = container.querySelector('.reminder-icon svg');
      expect(svg).not.toBeNull();
    });

    it('should have correct CSS class for styling', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '09:00',
          reminder_time: '08:55',
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const icon = container.querySelector('.reminder-icon');
      expect(icon?.classList.contains('reminder-icon')).toBe(true);
    });

    it('should have title attribute showing reminder time', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '09:00',
          reminder_time: '08:55',
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const icon = container.querySelector('.reminder-icon');
      // Tooltip should contain the reminder time
      expect(icon?.getAttribute('title')).toContain('08:55');
    });

    it('should display different reminder times correctly', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          path: '/tasks/test.md',
          isRoutine: false,
          estimatedMinutes: 30,
          scheduledTime: '10:30',
          reminder_time: '10:15',
        },
      } as TaskInstance;

      renderer.render(container, inst);

      const icon = container.querySelector('.reminder-icon');
      expect(icon?.getAttribute('title')).toContain('10:15');
    });
  });

  describe('hasReminder', () => {
    it('should return true when reminder_time is set', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          reminder_time: '08:55',
        },
      } as TaskInstance;

      expect(renderer.hasReminder(inst)).toBe(true);
    });

    it('should return false when reminder_time is not set', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          reminder_time: undefined,
        },
      } as TaskInstance;

      expect(renderer.hasReminder(inst)).toBe(false);
    });

    it('should return false when reminder_time is empty string', () => {
      const inst: TaskInstance = {
        instanceId: 'test-instance',
        date: '2025-01-15',
        state: 'idle',
        task: {
          id: 'test-task',
          name: 'Test Task',
          reminder_time: '',
        },
      } as TaskInstance;

      expect(renderer.hasReminder(inst)).toBe(false);
    });
  });
});
