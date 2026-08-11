import type { SectionBoundary } from '../types'
import type { TimeBoundary } from '../utils/time'

export class SectionConfigService {
  static readonly DEFAULT_BOUNDARIES: SectionBoundary[] = [
    { hour: 0, minute: 0 },
    { hour: 8, minute: 0 },
    { hour: 12, minute: 0 },
    { hour: 16, minute: 0 },
  ]

  private boundaries: SectionBoundary[]
  private slotKeysCache: string[]
  private boundaryMinutesCache: number[]

  constructor(customSections?: SectionBoundary[]) {
    const sanitized = SectionConfigService.sanitizeBoundaries(customSections)
    this.boundaries = sanitized ?? SectionConfigService.DEFAULT_BOUNDARIES
    this.boundaryMinutesCache = this.boundaries.map(b => b.hour * 60 + b.minute)
    this.slotKeysCache = this.buildSlotKeys()
  }

  static sanitizeBoundaries(input: unknown): SectionBoundary[] | undefined {
    if (!Array.isArray(input)) return undefined
    if (input.length < 2) return undefined

    const boundaries: SectionBoundary[] = []
    for (const item of input) {
      if (item == null || typeof item !== 'object') return undefined
      const candidate = item as Record<string, unknown>
      const h = candidate.hour
      const m = candidate.minute
      if (typeof h !== 'number' || typeof m !== 'number') return undefined
      if (!Number.isInteger(h) || !Number.isInteger(m)) return undefined
      if (h < 0 || h > 23 || m < 0 || m > 59) return undefined
      boundaries.push({ hour: h, minute: m })
    }

    // Day-boundary invariant: first section must start at 00:00
    if (boundaries[0].hour !== 0 || boundaries[0].minute !== 0) {
      return undefined
    }

    // Verify strictly ascending order
    for (let i = 1; i < boundaries.length; i++) {
      const prev = boundaries[i - 1].hour * 60 + boundaries[i - 1].minute
      const curr = boundaries[i].hour * 60 + boundaries[i].minute
      if (curr <= prev) return undefined
    }

    return boundaries
  }

  private buildSlotKeys(): string[] {
    const keys: string[] = []
    for (let i = 0; i < this.boundaries.length; i++) {
      const start = this.boundaries[i]
      const end = i + 1 < this.boundaries.length
        ? this.boundaries[i + 1]
        : this.boundaries[0] // wrap-around to first boundary
      const startStr = `${start.hour}:${String(start.minute).padStart(2, '0')}`
      const endStr = `${end.hour}:${String(end.minute).padStart(2, '0')}`
      keys.push(`${startStr}-${endStr}`)
    }
    return keys
  }

  getSlotKeys(): string[] {
    return this.slotKeysCache
  }

  getSlotFromTime(timeStr: string): string {
    const minutes = this.parseTimeToMinutes(timeStr)
    if (minutes == null) return this.slotKeysCache[0]
    return this.slotKeysCache[this.getSlotIndex(minutes)]
  }

  getCurrentTimeSlot(date: Date = new Date()): string {
    const minutes = date.getHours() * 60 + date.getMinutes()
    return this.slotKeysCache[this.getSlotIndex(minutes)]
  }

  calculateSlotKeyFromTime(timeStr: string | undefined): string | undefined {
    if (!timeStr) return undefined
    const minutes = this.parseTimeToMinutes(timeStr)
    if (minutes == null) return undefined
    return this.slotKeysCache[this.getSlotIndex(minutes)]
  }

  getTimeBoundaries(): TimeBoundary[] {
    return this.boundaries.map(b => ({ hour: b.hour, minute: b.minute }))
  }

  getSlotStartTime(slotKey: string): string | null {
    if (!slotKey || slotKey === 'none') return null
    const dashIdx = slotKey.indexOf('-')
    if (dashIdx < 0) return null
    const startPart = slotKey.slice(0, dashIdx)
    const minutes = this.parseTimeToMinutes(startPart)
    if (minutes == null) return null
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  isValidSlotKey(slotKey: string): boolean {
    if (slotKey === 'none') return true
    return this.slotKeysCache.includes(slotKey)
  }

  migrateSlotKey(oldKey: string): string {
    if (oldKey === 'none') return 'none'
    if (this.isValidSlotKey(oldKey)) return oldKey

    // Extract start time from old key (e.g. "8:00-12:00" → "8:00")
    const dashIdx = oldKey.indexOf('-')
    if (dashIdx < 0) return 'none'
    const startTime = oldKey.slice(0, dashIdx)
    if (!startTime) return 'none'

    return this.getSlotFromTime(startTime)
  }

  migrateOrderKey(oldKey: string): string {
    // "taskId::8:00-12:00" → "taskId::newSlotKey"
    const sepIdx = oldKey.indexOf('::')
    if (sepIdx < 0) return oldKey
    const taskPart = oldKey.slice(0, sepIdx)
    const slotPart = oldKey.slice(sepIdx + 2)
    const newSlot = this.migrateSlotKey(slotPart)
    return `${taskPart}::${newSlot}`
  }

  updateBoundaries(customSections?: SectionBoundary[]): void {
    const sanitized = SectionConfigService.sanitizeBoundaries(customSections)
    this.boundaries = sanitized ?? SectionConfigService.DEFAULT_BOUNDARIES
    this.boundaryMinutesCache = this.boundaries.map(b => b.hour * 60 + b.minute)
    this.slotKeysCache = this.buildSlotKeys()
  }

  private getSlotIndex(totalMinutes: number): number {
    for (let i = this.boundaryMinutesCache.length - 1; i >= 0; i--) {
      if (totalMinutes >= this.boundaryMinutesCache[i]) return i
    }
    return this.boundaryMinutesCache.length - 1 // wrap-around
  }

  private parseTimeToMinutes(timeStr: string): number | undefined {
    if (!timeStr || typeof timeStr !== 'string') return undefined

    let timePart = timeStr.trim()
    if (!timePart) return undefined

    // Full ISO datetime should be interpreted as an instant and converted to local time.
    if (/^\d{4}-\d{2}-\d{2}T/.test(timePart)) {
      const date = new Date(timePart)
      if (!Number.isNaN(date.getTime())) {
        return date.getHours() * 60 + date.getMinutes()
      }
    }

    // Handle ISO 8601: extract time portion after 'T'
    const tIdx = timePart.indexOf('T')
    if (tIdx >= 0) {
      timePart = timePart.slice(tIdx + 1)
    }

    // Remove timezone suffix from time-only strings (e.g. "08:30:00.000+09:00")
    timePart = timePart.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '')

    // Parse H:MM, HH:MM, H:MM:SS(.sss), HH:MM:SS(.sss)
    const match = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/)
    if (!match) return undefined

    const h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    const s = match[3] ? parseInt(match[3], 10) : 0
    if (h < 0 || h > 23 || m < 0 || m > 59) return undefined
    if (s < 0 || s > 59) return undefined

    return h * 60 + m
  }
}
