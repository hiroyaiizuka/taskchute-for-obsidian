import { RoutineRule } from '../../../types';
import type { RoutineWeek } from '../../../types/TaskFields';

/**
 * RoutineService
 * - Single source of truth for routine parsing and due-date evaluation.
 * - Keeps backward-compatibility with existing frontmatter keys.
 */
export class RoutineService {
  /** Parse frontmatter into a normalized RoutineRule. */
  static parseFrontmatter(fm: Record<string, unknown> | undefined): RoutineRule | null {
    if (!fm || typeof fm !== 'object') return null;
    const isRoutine = fm.isRoutine === true;
    if (!isRoutine) return null;

    const typeRaw = fm.routine_type || fm.routineType || 'daily';
    const type = (typeRaw === 'daily' || typeRaw === 'weekly' || typeRaw === 'monthly')
      ? typeRaw
      : // Backward-compat: treat weekends/weekdays/custom as weekly variants
        'weekly';

    const enabled = fm.routine_enabled === false ? false : true; // default true
    const interval = this.#toPositiveInt(fm.routine_interval, 1);

    const rule: RoutineRule = {
      type,
      interval,
      start: this.#toDateStrOrUndef(fm.routine_start),
      end: this.#toDateStrOrUndef(fm.routine_end),
      enabled,
    };

    // Weekly: prefer normalized `routine_weekday`. Fallback to legacy fields.
    if (type === 'weekly') {
      const weekday = this.#toWeekday(fm.routine_weekday ?? fm.weekday);
      // Support legacy multi-weekday
      const weekdays: number[] | undefined = Array.isArray(fm.weekdays)
        ? fm.weekdays
            .map((candidate) => this.#toWeekday(candidate))
            .filter((value): value is number => value !== undefined)
        : undefined;

      // Special legacy types
      const legacyType = fm.routine_type;
      const legacySet = legacyType === 'weekdays' ? [1, 2, 3, 4, 5]
        : legacyType === 'weekends' ? [0, 6]
        : undefined;

      if (weekday !== undefined) rule.weekday = weekday;
      if (weekdays && weekdays.length > 0) rule.weekdaySet = weekdays;
      if (legacySet) rule.weekdaySet = legacySet;
    }

    // Monthly: normalized `routine_week` + `routine_weekday`. Fallback to legacy monthly_* keys.
    if (type === 'monthly') {
      // Normalized: routine_week is 1..5 or 'last'
      // Legacy: monthly_week is 0..4 or 'last' → convert to 1..5
      let week: number | 'last' | undefined;
      if (fm.routine_week !== undefined) {
        week = fm.routine_week === 'last' ? 'last' : this.#toPositiveInt(fm.routine_week, undefined);
      } else if (fm.monthly_week !== undefined) {
        if (fm.monthly_week === 'last') {
          week = 'last';
        } else {
          const zeroBased = this.#toPositiveInt(fm.monthly_week, undefined);
          week = zeroBased !== undefined ? (zeroBased + 1) : undefined;
        }
      }
      const weekday = this.#toWeekday(fm.routine_weekday ?? fm.monthly_weekday);
      if (week !== undefined) rule.week = week;
      if (weekday !== undefined) rule.monthWeekday = weekday;

      const weekSet = this.#toWeekSet((fm).routine_weeks ?? (fm).monthly_weeks);
      if (weekSet.length > 0) {
        rule.weekSet = weekSet;
      }
      const weekdaySet = this.#toWeekdaySet((fm).routine_weekdays ?? (fm).monthly_weekdays);
      if (weekdaySet.length > 0) {
        rule.monthWeekdaySet = weekdaySet;
      }
    }

    return rule;
  }

  /** Determine if a routine is due on the given date (YYYY-MM-DD). */
  static isDue(dateStr: string, rule: RoutineRule | null, movedTargetDate?: string | undefined): boolean {
    if (!rule) return false;
    if (!rule.enabled) return false;

    const date = this.#parseDate(dateStr);
    if (!date) return false;

    // target_date (or equivalent) override: snooze until the specified date,
    // force visibility on that date, then resume the normal cadence afterwards.
    if (movedTargetDate) {
      const moved = this.#parseDate(movedTargetDate);
      if (!moved) {
        return false;
      }

      const diff = this.#compareDate(date, moved);
      if (diff < 0) {
        return false; // still snoozed
      }

      if (diff === 0) {
        return true; // force visibility on the moved day
      }
      // diff > 0 → fall through to normal routine evaluation
    }

    // Range guard
    if (rule.start) {
      const s = this.#parseDate(rule.start);
      if (s && this.#compareDate(date, s) < 0) return false;
    }
    if (rule.end) {
      const e = this.#parseDate(rule.end);
      if (e && this.#compareDate(date, e) > 0) return false;
    }

    switch (rule.type) {
      case 'daily':
        return this.#isDailyDue(date, rule);
      case 'weekly':
        return this.#isWeeklyDue(date, rule);
      case 'monthly':
        return this.#isMonthlyDue(date, rule);
      default:
        return false;
    }
  }

  // ---------- Internal calculators ----------

  static #isDailyDue(date: Date, rule: RoutineRule): boolean {
    const interval = Math.max(1, rule.interval || 1);
    if (!rule.start) return (interval === 1); // no anchor -> daily if interval 1
    const s = this.#parseDate(rule.start)!;
    const diff = this.#daysDiff(s, date);
    return diff >= 0 && diff % interval === 0;
  }

  static #isWeeklyDue(date: Date, rule: RoutineRule): boolean {
    const interval = Math.max(1, rule.interval || 1);
    const start = rule.start ? this.#parseDate(rule.start)! : undefined;

    // Anchor by the Sunday of the start week, or by the week of 1970-01-04 if no start
    const anchor = start ? this.#weekStart(start) : this.#weekStart(new Date(1970, 0, 4));
    const currentWeekStart = this.#weekStart(date);
    const wdiff = Math.floor((currentWeekStart.getTime() - anchor.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (wdiff < 0 || wdiff % interval !== 0) {
      return false;
    }

    const { weekdaySet } = rule;
    if (weekdaySet && Array.isArray(weekdaySet) && weekdaySet.length > 0) {
      return weekdaySet.includes(date.getDay());
    }

    const { weekday } = rule;
    if (weekday === undefined) return false;
    return date.getDay() === weekday;
  }

  static #isMonthlyDue(date: Date, rule: RoutineRule): boolean {
    const weekCandidates = (rule.weekSet && rule.weekSet.length > 0)
      ? rule.weekSet
      : rule.week !== undefined
        ? [rule.week]
        : [];
    const weekdayCandidates = (rule.monthWeekdaySet && rule.monthWeekdaySet.length > 0)
      ? rule.monthWeekdaySet
      : rule.monthWeekday !== undefined
        ? [rule.monthWeekday]
        : [];
    if (weekCandidates.length === 0 || weekdayCandidates.length === 0) return false;
    const interval = Math.max(1, rule.interval || 1);

    // Interval guard by month difference
    if (rule.start) {
      const s = this.#parseDate(rule.start)!;
      const mdiff = (date.getFullYear() - s.getFullYear()) * 12 + (date.getMonth() - s.getMonth());
      if (mdiff < 0 || mdiff % interval !== 0) return false;
    }

    // Find the target date inside this month
    const nextWeek = new Date(date);
    nextWeek.setDate(date.getDate() + 7);
    const isLast = nextWeek.getMonth() !== date.getMonth();
    const occurrence = Math.floor((date.getDate() - 1) / 7) + 1; // 1-based

    const matchesWeek = weekCandidates.some((candidate) =>
      candidate === 'last' ? isLast : occurrence === candidate,
    );
    const matchesWeekday = weekdayCandidates.includes(date.getDay());
    return matchesWeek && matchesWeekday;
  }

  // ---------- Helpers ----------
  static #toPositiveInt(value: unknown, fallback: number | undefined): number {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    return fallback ?? 1;
  }

  static #toWeekday(value: unknown): number | undefined {
    const n = Number(value);
    return this.#isValidWeekday(n) ? n : undefined;
  }

  static #toWeekdaySet(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<number>();
    return value
      .map((candidate) => this.#toWeekday(candidate))
      .filter((weekday): weekday is number => typeof weekday === 'number')
      .filter((weekday) => {
        if (seen.has(weekday)) return false;
        seen.add(weekday);
        return true;
      })
      .sort((a, b) => a - b);
  }

  static #toWeekSet(value: unknown): Array<number | 'last'> {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: Array<number | 'last'> = [];
    for (const candidate of value) {
      if (candidate === 'last') {
        if (!seen.has('last')) {
          seen.add('last');
          result.push('last');
        }
        continue;
      }
      const parsed = this.#toPositiveInt(candidate, undefined);
      if (parsed && parsed >= 1 && parsed <= 5) {
        const key = String(parsed);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(parsed as RoutineWeek);
        }
      }
    }
    return result;
  }

  static #isValidWeekday(n: number): n is number {
    return Number.isInteger(n) && n >= 0 && n <= 6;
  }

  static #toDateStrOrUndef(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    // simple YYYY-MM-DD check
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  }

  static #parseDate(dateStr: string): Date | null {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) return null;
    const [y, mo, d] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, d);
  }

  static #compareDate(a: Date, b: Date): number {
    const aKey = a.getFullYear() * 10000 + (a.getMonth() + 1) * 100 + a.getDate();
    const bKey = b.getFullYear() * 10000 + (b.getMonth() + 1) * 100 + b.getDate();
    return aKey === bKey ? 0 : (aKey < bKey ? -1 : 1);
  }

  static #daysDiff(a: Date, b: Date): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.floor((utcB - utcA) / msPerDay);
  }

  static #weekStart(date: Date): Date {
    const d = new Date(date);
    const dow = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - dow);
    d.setHours(0, 0, 0, 0);
    return d;
  }
}

export default RoutineService;
