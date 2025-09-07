/**
 * Pure time/week functions used by TaskChuteView
 */

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

export function getCurrentTimeSlot(date: Date = new Date()): string {
  const hour = date.getHours();
  const minute = date.getMinutes();
  const timeInMinutes = hour * 60 + minute;
  
  if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) return "0:00-8:00";
  if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) return "8:00-12:00";
  if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) return "12:00-16:00";
  return "16:00-0:00";
}

export function getSlotFromTime(timeStr: string): string {
  const [hour, minute] = String(timeStr).split(":").map(Number);
  const timeInMinutes = hour * 60 + minute;
  
  if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) return "0:00-8:00";
  if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) return "8:00-12:00";
  if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) return "12:00-16:00";
  return "16:00-0:00";
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