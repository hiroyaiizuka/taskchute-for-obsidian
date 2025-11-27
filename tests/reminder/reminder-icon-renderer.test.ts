/**
 * Tests for ReminderIconRenderer.
 *
 * These tests verify that:
 * 1. Bell icon is rendered for tasks with reminder_time
 * 2. Tooltip shows the reminder time
 * 3. Click handler opens the ReminderSettingsModal
 * 4. No icon is rendered for tasks without reminder
 */

import { ReminderIconRenderer } from '../../src/features/reminder/ui/ReminderIconRenderer';
import type { TaskInstance } from '../../src/types';

// Mock createEl for testing
const mockCreateEl = (tag: string, options?: Record<string, unknown>): HTMLElement => {
  const el = document.createElement(tag);
  if (options?.cls) {
    const rawClasses = Array.isArray(options.cls) ? options.cls : [options.cls];
    const classes = (rawClasses as string[])
      .flatMap(c => c.split(' '))
      .filter(c => c.length > 0);
    if (classes.length > 0) {
      (el).classList.add(...classes);
    }
  }
  if (options?.text !== undefined) {
    el.textContent = options.text as string;
  }
  if (options?.attr) {
    Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
      el.setAttribute(key, value);
    });
  }
  return el;
};

// Extend HTMLElement prototype for tests
Object.defineProperty(HTMLElement.prototype, 'createEl', {
  value: function(tag: string, options?: Record<string, unknown>) {
    const el = mockCreateEl(tag, options);
    this.appendChild(el);
    return el;
  },
  writable: true,
  configurable: true,
});

// Mock createSvg for testing
Object.defineProperty(HTMLElement.prototype, 'createSvg', {
  value: function(tag: string, options?: Record<string, unknown>) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (options?.cls) {
      el.setAttribute('class', options.cls as string);
    }
    if (options?.attr) {
      Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }
    this.appendChild(el);
    return el;
  },
  writable: true,
  configurable: true,
});

Object.defineProperty(SVGElement.prototype, 'createSvg', {
  value: function(tag: string, options?: Record<string, unknown>) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (options?.cls) {
      el.setAttribute('class', options.cls as string);
    }
    if (options?.attr) {
      Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }
    this.appendChild(el);
    return el;
  },
  writable: true,
  configurable: true,
});

describe('ReminderIconRenderer', () => {
  const mockTv = (key: string, fallback: string, vars?: Record<string, string | number>): string => {
    if (vars?.time) {
      return fallback.replace('{time}', String(vars.time));
    }
    return fallback;
  };

  const createMockTask = (reminderTime?: string): TaskInstance => ({
    task: {
      path: 'tasks/test.md',
      name: 'Test Task',
      reminder_time: reminderTime,
      scheduledTime: '10:00',
    },
    date: '2025-01-15',
    slotKey: 'slot-08-12',
    state: 'pending',
  } as TaskInstance);

  describe('hasReminder', () => {
    it('should return true when reminder_time is set', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask('09:55');

      expect(renderer.hasReminder(task)).toBe(true);
    });

    it('should return false when reminder_time is not set', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask(undefined);

      expect(renderer.hasReminder(task)).toBe(false);
    });

    it('should return false when reminder_time is empty string', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask('');

      expect(renderer.hasReminder(task)).toBe(false);
    });
  });

  describe('render', () => {
    it('should render bell icon when reminder is set', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask('09:55');
      const container = document.createElement('div');

      renderer.render(container, task);

      const iconContainer = container.querySelector('.reminder-icon');
      expect(iconContainer).not.toBeNull();

      // Check for bell SVG (should have path element for bell shape)
      const svg = iconContainer?.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.querySelector('path')).not.toBeNull(); // Bell uses path, not circle
    });

    it('should not render anything when no reminder is set', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask(undefined);
      const container = document.createElement('div');

      renderer.render(container, task);

      expect(container.querySelector('.reminder-icon')).toBeNull();
    });

    it('should set tooltip with reminder time', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask('14:30');
      const container = document.createElement('div');

      renderer.render(container, task);

      const iconContainer = container.querySelector('.reminder-icon');
      expect(iconContainer?.getAttribute('title')).toContain('14:30');
    });

    it('should call onClick callback when clicked', () => {
      const onClickMock = jest.fn();
      const renderer = new ReminderIconRenderer({
        tv: mockTv,
        onClick: onClickMock,
      });
      const task = createMockTask('09:55');
      const container = document.createElement('div');

      renderer.render(container, task);

      const iconContainer = container.querySelector('.reminder-icon');
      expect(iconContainer).not.toBeNull();

      // Simulate click
      iconContainer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClickMock).toHaveBeenCalledTimes(1);
      expect(onClickMock).toHaveBeenCalledWith(task);
    });

    it('should stop event propagation on click', () => {
      const onClickMock = jest.fn();
      const renderer = new ReminderIconRenderer({
        tv: mockTv,
        onClick: onClickMock,
      });
      const task = createMockTask('09:55');
      const container = document.createElement('div');

      renderer.render(container, task);

      const iconContainer = container.querySelector('.reminder-icon');
      const clickEvent = new MouseEvent('click', { bubbles: true });
      const stopPropagationSpy = jest.spyOn(clickEvent, 'stopPropagation');

      iconContainer?.dispatchEvent(clickEvent);

      expect(stopPropagationSpy).toHaveBeenCalled();
    });
  });

  describe('icon style', () => {
    it('should render with clickable cursor style class', () => {
      const renderer = new ReminderIconRenderer({
        tv: mockTv,
        onClick: jest.fn(),
      });
      const task = createMockTask('09:55');
      const container = document.createElement('div');

      renderer.render(container, task);

      const iconContainer = container.querySelector('.reminder-icon');
      expect(iconContainer?.classList.contains('reminder-icon--clickable')).toBe(true);
    });

    it('should not have clickable class when no onClick provided', () => {
      const renderer = new ReminderIconRenderer({ tv: mockTv });
      const task = createMockTask('09:55');
      const container = document.createElement('div');

      renderer.render(container, task);

      const iconContainer = container.querySelector('.reminder-icon');
      expect(iconContainer?.classList.contains('reminder-icon--clickable')).toBe(false);
    });
  });
});
