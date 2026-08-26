import type { SectionBoundary } from "../../../types"
import { SectionConfigService } from "../../../services/SectionConfigService"

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/

export function formatBoundary(boundary: SectionBoundary): string {
  return `${String(boundary.hour).padStart(2, "0")}:${String(
    boundary.minute,
  ).padStart(2, "0")}`
}

/** Parses "HH:MM", rejecting anything outside a real time of day. */
export function parseBoundary(raw: string): SectionBoundary | undefined {
  const match = TIME_PATTERN.exec(raw.trim())
  if (!match) return undefined
  const hour = parseInt(match[1], 10)
  const minute = parseInt(match[2], 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return { hour, minute }
}

/**
 * The boundaries being edited, before Apply writes them through.
 *
 * Owned by the settings tab rather than by a render pass. Adding or removing a
 * row changes how many rows there are, which means rebuilding the definitions —
 * and a draft re-seeded from the saved settings on every rebuild would throw
 * away the edit that caused the rebuild. Seeding happens once; `reseed` is for
 * the two points where the saved value legitimately becomes the new starting
 * point: a successful Apply, and closing the tab.
 */
export class SectionBoundaryDraft {
  private boundaries: SectionBoundary[] = []
  private seeded = false

  ensureSeeded(stored: SectionBoundary[] | undefined): void {
    if (this.seeded) return
    this.reseed(stored)
  }

  reseed(stored: SectionBoundary[] | undefined): void {
    const current =
      SectionConfigService.sanitizeBoundaries(stored) ??
      SectionConfigService.DEFAULT_BOUNDARIES
    this.boundaries = current.map((boundary) => ({ ...boundary }))
    this.seeded = true
  }

  get list(): readonly SectionBoundary[] {
    return this.boundaries
  }

  /** A detached copy, safe to hand to code that persists it. */
  snapshot(): SectionBoundary[] {
    return this.boundaries.map((boundary) => ({ ...boundary }))
  }

  format(index: number): string {
    const boundary = this.boundaries[index]
    return boundary ? formatBoundary(boundary) : ""
  }

  set(index: number, boundary: SectionBoundary): void {
    if (index < 0 || index >= this.boundaries.length) return
    this.boundaries[index] = boundary
  }

  /** Four hours after the last one, without running past the end of the day. */
  add(): void {
    const last = this.boundaries[this.boundaries.length - 1]
    const hour = last ? Math.min(23, last.hour + 4) : 0
    this.boundaries.push({ hour, minute: 0 })
  }

  removeAt(index: number): void {
    this.boundaries.splice(index, 1)
  }

  resetToDefault(): void {
    this.boundaries = SectionConfigService.DEFAULT_BOUNDARIES.map(
      (boundary) => ({ ...boundary }),
    )
  }

  sort(): void {
    this.boundaries.sort(
      (a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute),
    )
  }
}
