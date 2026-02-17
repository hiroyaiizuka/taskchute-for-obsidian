/**
 * ReminderIconRenderer - Renders reminder icon in task row
 *
 * Displays a bell icon for tasks that have reminders set.
 * Icon is hidden when no reminder is configured.
 * Clicking the icon opens the ReminderSettingsModal.
 */

import type { TaskInstance } from '../../../types';
import { normalizeReminderTime } from '../services/ReminderFrontmatterService';

export interface ReminderIconRendererOptions {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string;
  /** Optional click handler - when provided, icon becomes clickable */
  onClick?: (inst: TaskInstance) => void;
}

export class ReminderIconRenderer {
  constructor(private readonly options: ReminderIconRendererOptions) {}

  /**
   * Check if a task instance has a reminder set.
   */
  hasReminder(inst: TaskInstance): boolean {
    return normalizeReminderTime(inst.task.reminder_time) !== undefined;
  }

  /**
   * Render the reminder icon into the container.
   * Does nothing if no reminder is set.
   */
  render(container: HTMLElement, inst: TaskInstance): void {
    const reminderTime = normalizeReminderTime(inst.task.reminder_time);
    if (!reminderTime) {
      return;
    }

    const title = this.buildTooltipText(reminderTime);
    const isClickable = typeof this.options.onClick === 'function';

    const classes = isClickable ? 'reminder-icon reminder-icon--clickable' : 'reminder-icon';

    const iconContainer = this.createEl(container, 'span', {
      cls: classes,
      attr: { title },
    });

    // Add click handler if provided
    if (isClickable) {
      iconContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        this.options.onClick!(inst);
      });
    }

    // Create bell SVG icon
    this.renderBellSvg(iconContainer);
  }

  /**
   * Build tooltip text showing reminder time.
   * Shows "HH:mm にリマインダー" format.
   */
  private buildTooltipText(reminderTime: string): string {
    return this.options.tv(
      'tooltips.reminderAtTime',
      `${reminderTime} にリマインダー`,
      { time: reminderTime }
    );
  }

  /**
   * Create an element with Obsidian's createEl or fallback.
   */
  private createEl(
    parent: HTMLElement,
    tag: string,
    options?: { cls?: string; text?: string; attr?: Record<string, string> }
  ): HTMLElement {
    const maybeCreateEl = (
      parent as HTMLElement & {
        createEl?: (tagName: string, options?: Record<string, unknown>) => HTMLElement;
      }
    ).createEl;

    if (typeof maybeCreateEl === 'function') {
      const result: HTMLElement = maybeCreateEl.call(parent, tag, options as Record<string, unknown> | undefined) as HTMLElement;
      return result;
    }

    // Fallback for non-Obsidian environments
    const el = document.createElement(tag);
    if (options?.cls) {
      const classes = options.cls.split(' ').filter(c => c.length > 0);
      if (classes.length > 0) {
        el.classList.add(...classes);
      }
    }
    if (options?.text) {
      el.textContent = options.text;
    }
    if (options?.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }
    parent.appendChild(el);
    return el;
  }

  /**
   * Create an SVG element with Obsidian's createSvg or fallback.
   */
  private createSvg(
    parent: HTMLElement | SVGElement,
    tag: string,
    options?: { cls?: string; attr?: Record<string, string> }
  ): SVGElement {
    const maybeCreateSvg = (
      parent as (HTMLElement | SVGElement) & {
        createSvg?: (tagName: string, options?: Record<string, unknown>) => SVGElement;
      }
    ).createSvg;

    if (typeof maybeCreateSvg === 'function') {
      const result: SVGElement = maybeCreateSvg.call(parent, tag, options as Record<string, unknown> | undefined) as SVGElement;
      return result;
    }

    // Fallback for non-Obsidian environments
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (options?.cls) {
      el.setAttribute('class', options.cls);
    }
    if (options?.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }
    parent.appendChild(el);
    return el;
  }

  /**
   * Render a bell SVG icon.
   */
  private renderBellSvg(container: HTMLElement): void {
    const svg = this.createSvg(container, 'svg', {
      cls: 'reminder-icon-svg',
      attr: {
        viewBox: '0 0 24 24',
        width: '14',
        height: '14',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    });

    // Bell shape path (Lucide bell icon style)
    this.createSvg(svg, 'path', {
      attr: {
        d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9',
      },
    });

    // Bell clapper
    this.createSvg(svg, 'path', {
      attr: {
        d: 'M13.73 21a2 2 0 0 1-3.46 0',
      },
    });
  }
}
