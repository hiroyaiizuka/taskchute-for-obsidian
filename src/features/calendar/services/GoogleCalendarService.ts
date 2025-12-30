import { App } from "obsidian"
import type { GoogleCalendarSettings, TaskInstance } from "../../../types"
import { ensureFrontmatterObject } from "../../../utils/frontmatter"
import { isTimeString } from "../../../types/TaskFields"

const MAX_DESCRIPTION_LENGTH = 2000

export interface CalendarEventBuildOptions {
  viewDate: Date
  defaultDurationMinutes: number
  overrideStartTime?: string | null
  overrideDurationMinutes?: number | null
  noteBody?: string
  overrideDateKey?: string | null
}

export interface CalendarEventBuildResult {
  title: string
  start: Date
  end: Date
  dateKey: string
  startTimeText: string
  endTimeText: string
  description: string
  recurrenceRule?: string | null
}

interface RecurrenceBuildResult {
  rule: string | null
  alignWeekday?: number
}

export class GoogleCalendarService {
  constructor(private readonly app: App) {}

  async buildEventFromTask(
    inst: TaskInstance,
    settings: GoogleCalendarSettings,
    options: CalendarEventBuildOptions,
  ): Promise<CalendarEventBuildResult> {
    let dateKey = this.resolveDateKey(
      inst,
      options.viewDate,
      options.overrideDateKey,
    )
    if (!dateKey) {
      throw new Error("日付を特定できませんでした")
    }

    const startTime = this.resolveStartTime(inst, options.overrideStartTime)
    if (!startTime) {
      throw new Error("開始時刻を決められませんでした")
    }

    const recurrence = this.buildRecurrenceRule(inst)

    if (recurrence.alignWeekday !== undefined) {
      const aligned = this.alignDateToWeekday(dateKey, recurrence.alignWeekday)
      dateKey = aligned
    }

    const durationMinutes = this.resolveDuration(
      inst,
      options.overrideDurationMinutes,
      options.defaultDurationMinutes ?? settings.defaultDurationMinutes ?? 60,
    )
    const start = this.toDate(dateKey, startTime)
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000)

    const noteBody = options.noteBody ?? (await this.readNoteBody(inst))

    const description = this.buildDescription(noteBody)

    return {
      title: this.getTitle(inst),
      start,
      end,
      dateKey,
      startTimeText: this.formatTime(start),
      endTimeText: this.formatTime(end),
      description,
      recurrenceRule: recurrence.rule,
    }
  }

  buildEventUrl(event: CalendarEventBuildResult): string {
    const params = new URLSearchParams()
    params.set("action", "TEMPLATE")
    params.set("text", event.title)
    params.set(
      "dates",
      `${this.formatDateTime(event.start)}/${this.formatDateTime(event.end)}`,
    )
    params.set("details", event.description)
    if (event.recurrenceRule) {
      params.set("recur", `RRULE:${event.recurrenceRule}`)
    }
    return `https://calendar.google.com/calendar/render?${params.toString()}`
  }

  open(url: string): void {
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener")
    }
  }

  private getTitle(inst: TaskInstance): string {
    const candidates = [
      inst.task.displayTitle,
      inst.executedTitle,
      inst.task.name,
      inst.task.path,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate
      }
    }
    return "Task"
  }

  private resolveDateKey(
    inst: TaskInstance,
    viewDate: Date,
    overrideDateKey?: string | null,
  ): string | null {
    if (typeof overrideDateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(overrideDateKey)) {
      return overrideDateKey
    }

    const frontmatter = ensureFrontmatterObject(inst.task.frontmatter)
    const candidates = [
      inst.date,
      frontmatter.execution_date,
      frontmatter.temporary_move_date,
      frontmatter.target_date,
      this.formatDateKey(viewDate),
    ]

    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        return candidate
      }
    }
    return null
  }

  private resolveStartTime(
    inst: TaskInstance,
    overrideStartTime?: string | null,
  ): string | null {
    if (overrideStartTime !== undefined && overrideStartTime !== null) {
      if (!isTimeString(overrideStartTime)) {
        throw new Error("開始時刻はHH:mm形式で入力してください")
      }
      return overrideStartTime
    }

    const frontmatter = ensureFrontmatterObject(inst.task.frontmatter)
    const candidates = [
      inst.task.scheduledTime,
      frontmatter.scheduled_time,
      frontmatter["開始時刻"],
    ]

    for (const candidate of candidates) {
      if (typeof candidate === "string" && isTimeString(candidate)) {
        return candidate
      }
    }

    const slotTime = this.getSlotStartTime(inst.slotKey)
    if (slotTime) {
      return slotTime
    }

    const now = new Date()
    return [now.getHours(), now.getMinutes()]
      .map((v) => String(v).padStart(2, "0"))
      .join(":")
  }

  private resolveDuration(
    inst: TaskInstance,
    overrideDurationMinutes: number | null | undefined,
    defaultDurationMinutes: number,
  ): number {
    if (
      overrideDurationMinutes !== undefined &&
      overrideDurationMinutes !== null
    ) {
      if (!Number.isFinite(overrideDurationMinutes) || overrideDurationMinutes <= 0) {
        throw new Error("所要時間は1分以上の数値を入力してください")
      }
      return Math.round(overrideDurationMinutes)
    }
    if (typeof inst.task.estimatedMinutes === "number") {
      const normalized = Math.max(1, Math.round(inst.task.estimatedMinutes))
      return normalized
    }
    const normalizedDefault = Number.isFinite(defaultDurationMinutes)
      ? Math.max(1, Math.round(defaultDurationMinutes))
      : 60
    return normalizedDefault
  }

  async readNoteBody(inst: TaskInstance): Promise<string> {
    const file = inst.task.file
    if (!file) return ""

    try {
      const content = await this.app.vault.read(file)
      return this.stripFrontmatter(content)
    } catch (error) {
      console.error("[GoogleCalendarService] Failed to read note content", error)
      return ""
    }
  }

  private stripFrontmatter(content: string): string {
    const trimmed = content.trimStart()
    if (!trimmed.startsWith("---")) {
      return this.truncate(trimmed)
    }

    const end = trimmed.indexOf("\n---", 3)
    if (end === -1) {
      return this.truncate(trimmed)
    }

    const body = trimmed.slice(end + 4)
    return this.truncate(body.trimStart())
  }

  private buildDescription(noteBody: string): string {
    const trimmed = (noteBody ?? "").trim()
    return this.truncate(trimmed)
  }

  private getSlotStartTime(slotKey: string): string | null {
    switch (slotKey) {
      case "0:00-8:00":
        return "00:00"
      case "8:00-12:00":
        return "08:00"
      case "12:00-16:00":
        return "12:00"
      case "16:00-0:00":
        return "16:00"
      default:
        return null
    }
  }

  private formatDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
  }

  private toDate(dateKey: string, time: string): Date {
    const [year, month, day] = dateKey.split("-").map((part) => Number(part))
    const [hour, minute] = time.split(":").map((part) => Number(part))
    return new Date(year, month - 1, day, hour, minute, 0, 0)
  }

  private formatTime(date: Date): string {
    const h = String(date.getHours()).padStart(2, "0")
    const m = String(date.getMinutes()).padStart(2, "0")
    return `${h}:${m}`
  }

  private formatDateTime(date: Date): string {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, "0")
    const day = String(date.getUTCDate()).padStart(2, "0")
    const hour = String(date.getUTCHours()).padStart(2, "0")
    const minute = String(date.getUTCMinutes()).padStart(2, "0")
    const second = String(date.getUTCSeconds()).padStart(2, "0")
    return `${year}${month}${day}T${hour}${minute}${second}Z`
  }

  private truncate(value: string, maxLength = MAX_DESCRIPTION_LENGTH): string {
    if (value.length <= maxLength) {
      return value
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`
  }

  private buildRecurrenceRule(inst: TaskInstance): RecurrenceBuildResult {
    if (!inst.task.isRoutine) {
      return { rule: null }
    }
    const fm = ensureFrontmatterObject(inst.task.frontmatter)
    const type = fm.routine_type ?? inst.task.routine_type
    const enabled = fm.routine_enabled ?? inst.task.routine_enabled
    if (enabled === false) {
      return { rule: null }
    }

    const intervalRaw =
      fm.routine_interval ?? inst.task.routine_interval ?? 1
    const interval =
      typeof intervalRaw === "number" && intervalRaw > 0
        ? Math.round(intervalRaw)
        : 1

    if (type === "daily") {
      return { rule: `FREQ=DAILY;INTERVAL=${interval}` }
    }

    if (type === "weekly") {
      const days = this.getWeekdayCodes(
        inst.task.routine_weekdays ??
          inst.task.weekdays ??
          inst.task.routine_weekday ??
          fm.routine_weekdays ??
          fm.weekdays ??
          fm.routine_weekday,
      )
      if (!days.length) return { rule: null }
      return {
        rule: `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${days.join(",")}`,
        alignWeekday: this.dayCodeToNumber(days[0]),
      }
    }

    if (type === "monthly") {
      const weekEntries = this.getMonthlyByDayEntries(
        inst.task.routine_weeks ?? inst.task.routine_week ?? fm.routine_weeks ?? fm.routine_week,
        inst.task.routine_weekdays ?? inst.task.weekdays ?? fm.routine_weekdays ?? fm.weekdays,
      )
      if (!weekEntries.length) return { rule: null }
      return {
        rule: `FREQ=MONTHLY;INTERVAL=${interval};BYDAY=${weekEntries.join(",")}`,
      }
    }

    if (type === "monthly_date") {
      const monthdayEntries = this.getMonthlyByMonthdayEntries(
        inst.task.routine_monthdays ??
          inst.task.routine_monthday ??
          fm.routine_monthdays ??
          fm.routine_monthday,
      )
      if (!monthdayEntries.length) return { rule: null }
      return {
        rule: `FREQ=MONTHLY;INTERVAL=${interval};BYMONTHDAY=${monthdayEntries.join(",")}`,
      }
    }

    return { rule: null }
  }

  private getWeekdayCodes(value: unknown): string[] {
    const toArray = (input: unknown): number[] => {
      if (Array.isArray(input)) {
        return input
          .map((v) => (typeof v === "number" ? v : Number(v)))
          .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
      }
      if (typeof input === "number") {
        return [input]
      }
      return []
    }

    const days = toArray(value)
    return Array.from(new Set(days)).map((d) => this.toDayCode(d))
  }

  private getMonthlyByDayEntries(
    weeksInput: unknown,
    weekdaysInput: unknown,
  ): string[] {
    const toWeeks = (input: unknown): Array<number | "last"> => {
      if (Array.isArray(input)) {
        return input
          .map((v) => {
            if (v === "last") return "last"
            const num = Number(v)
            if (Number.isInteger(num) && num >= 1 && num <= 5) {
              return num
            }
            return null
          })
          .filter((v): v is number | "last" => v !== null)
      }
      if (input === "last") return ["last"]
      const num = Number(input)
      if (Number.isInteger(num) && num >= 1 && num <= 5) {
        return [num]
      }
      return []
    }

    const toWeekdays = (input: unknown): number[] => {
      if (Array.isArray(input)) {
        return input
          .map((v) => (typeof v === "number" ? v : Number(v)))
          .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
      }
      if (typeof input === "number") {
        return [input]
      }
      return []
    }

    const weeks = toWeeks(weeksInput)
    const weekdays = toWeekdays(weekdaysInput)
    if (!weeks.length || !weekdays.length) return []

    const entries: string[] = []
    for (const week of weeks) {
      const weekCode = week === "last" ? -1 : week
      for (const weekday of weekdays) {
        const dayCode = this.toDayCode(weekday)
        entries.push(`${weekCode}${dayCode}`)
      }
    }
    return Array.from(new Set(entries))
  }

  private getMonthlyByMonthdayEntries(input: unknown): string[] {
    const toMonthdays = (value: unknown): Array<number | "last"> => {
      if (Array.isArray(value)) {
        return value
          .map((v) => {
            if (v === "last") return "last"
            const num = Number(v)
            if (Number.isInteger(num) && num >= 1 && num <= 31) {
              return num
            }
            return null
          })
          .filter((v): v is number | "last" => v !== null)
      }
      if (value === "last") return ["last"]
      const num = Number(value)
      if (Number.isInteger(num) && num >= 1 && num <= 31) {
        return [num]
      }
      return []
    }

    const monthdays = toMonthdays(input)
    if (!monthdays.length) return []
    const normalized = monthdays.map((day) => (day === "last" ? -1 : day))
    return Array.from(new Set(normalized)).map((day) => String(day))
  }

  private toDayCode(day: number): string {
    const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    return map[day] ?? "SU"
  }

  private dayCodeToNumber(code: string): number {
    const map: Record<string, number> = {
      SU: 0,
      MO: 1,
      TU: 2,
      WE: 3,
      TH: 4,
      FR: 5,
      SA: 6,
    }
    return map[code] ?? 0
  }

  private parseDateKey(dateKey: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null
    const [y, m, d] = dateKey.split("-").map((v) => Number(v))
    return new Date(y, m - 1, d)
  }

  private getWeekOfMonth(date: Date): number {
    const day = date.getDate()
    return Math.min(5, Math.floor((day - 1) / 7) + 1)
  }

  private alignDateToWeekday(dateKey: string, weekday: number): string {
    const date = this.parseDateKey(dateKey)
    if (!date) return dateKey
    const target = weekday % 7
    let current = date.getDay()
    let offset = 0
    while (current !== target && offset < 7) {
      date.setDate(date.getDate() + 1)
      current = date.getDay()
      offset += 1
    }
    return this.formatDateKey(date)
  }
}
