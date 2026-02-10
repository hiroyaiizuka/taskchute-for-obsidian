/**
 * Pure time/week functions used by TaskChuteView
 */

import { SectionConfigService } from '../services/SectionConfigService'

export interface TimeBoundary {
  hour: number;
  minute: number;
}

export function calculateNextBoundary(
  now: Date,
  boundaries: TimeBoundary[]
): Date {
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  for (const boundary of boundaries) {
    if (
      boundary.hour > currentHour ||
      (boundary.hour === currentHour && boundary.minute > currentMinute)
    ) {
      const next = new Date(now);
      next.setHours(boundary.hour, boundary.minute, 0, 0);
      return next;
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(boundaries[0].hour, boundaries[0].minute, 0, 0);
  return tomorrow;
}

// Default service singleton (backward-compat fallback for callers without a SectionConfigService)
const defaultService = new SectionConfigService()

export function getCurrentTimeSlot(date: Date = new Date()): string {
  return defaultService.getCurrentTimeSlot(date)
}

export function getSlotFromTime(timeStr: string): string {
  return defaultService.getSlotFromTime(timeStr)
}

export function isTargetWeekday(date: Date, weekday: number): boolean {
  return date.getDay() === weekday;
}

export function getNthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number | "last"
): Date | null {
  if (n === "last") {
    const lastDay = new Date(year, month + 1, 0);
    let currentDay = lastDay.getDate();
    
    while (currentDay >= 1) {
      const date = new Date(year, month, currentDay);
      if (date.getDay() === weekday) return date;
      currentDay--;
    }
    return null;
  } else {
    const lastDay = new Date(year, month + 1, 0);
    let count = 0;
    
    for (let day = 1; day <= lastDay.getDate(); day++) {
      const date = new Date(year, month, day);
      if (date.getDay() === weekday) {
        count++;
        if (count === n) return date;
      }
    }
    return null;
  }
}

export function getWeekdayName(weekday: number): string {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return weekdays[weekday] || "";
}

export function getWeekdayNumber(weekdayName: string): number {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return weekdays.indexOf(weekdayName);
}