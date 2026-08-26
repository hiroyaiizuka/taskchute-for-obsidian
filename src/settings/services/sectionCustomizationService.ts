import { SectionBoundary } from "../../types"
import { t } from "../../i18n"
import { SectionConfigService } from "../../services/SectionConfigService"
import type { PluginWithSettings } from "../pluginWithSettings"
import { notifySectionSettingsChanged } from "./viewNotifications"

function minutesOf(boundary: SectionBoundary): number {
  return boundary.hour * 60 + boundary.minute
}

function sameBoundaries(
  a: readonly SectionBoundary[],
  b: readonly SectionBoundary[],
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.hour === b[i].hour && x.minute === b[i].minute)
  )
}

/** The boundaries currently in effect, defaults included. */
export function storedBoundaries(
  plugin: PluginWithSettings,
): readonly SectionBoundary[] {
  return (
    SectionConfigService.sanitizeBoundaries(plugin.settings.customSections) ??
    SectionConfigService.DEFAULT_BOUNDARIES
  )
}

export function isDefaultBoundaries(
  draft: readonly SectionBoundary[],
): boolean {
  return sameBoundaries(draft, SectionConfigService.DEFAULT_BOUNDARIES)
}

export function isUnchangedBoundaries(
  draft: readonly SectionBoundary[],
  plugin: PluginWithSettings,
): boolean {
  return sameBoundaries(draft, storedBoundaries(plugin))
}

/**
 * Checks a sorted draft. Returns a localized message to show the user, or null
 * when the draft can be applied.
 */
export function validateBoundaries(
  draft: readonly SectionBoundary[],
): string | null {
  if (draft.length < 2) {
    return t(
      "settings.advanced.sectionCustomize.validation.minimum",
      "At least 2 boundaries are required",
    )
  }
  if (draft[0].hour !== 0 || draft[0].minute !== 0) {
    return t(
      "settings.advanced.sectionCustomize.validation.firstMustBeZero",
      "The first boundary must be 0:00",
    )
  }
  for (let i = 1; i < draft.length; i++) {
    const prev = minutesOf(draft[i - 1])
    const curr = minutesOf(draft[i])
    if (curr === prev) {
      return t(
        "settings.advanced.sectionCustomize.validation.duplicate",
        "Duplicate boundary times exist",
      )
    }
    if (curr < prev) {
      return t(
        "settings.advanced.sectionCustomize.validation.notAscending",
        "Boundaries must be in ascending order",
      )
    }
  }
  return null
}

/**
 * Persists new boundaries and brings existing data along.
 *
 * Manual slot assignments are kept wherever the old key still names a real
 * slot; the rest are migrated onto the nearest new boundary, so a boundary
 * change never silently drops a task the user placed by hand.
 *
 * Pass undefined to go back to the defaults.
 */
export async function applySectionCustomization(
  plugin: PluginWithSettings,
  newBoundaries: SectionBoundary[] | undefined,
): Promise<void> {
  const newConfig = new SectionConfigService(newBoundaries)
  const migratedSlotKeys: Record<string, string> = {}
  for (const [taskId, oldSlot] of Object.entries(plugin.settings.slotKeys)) {
    migratedSlotKeys[taskId] = newConfig.isValidSlotKey(oldSlot)
      ? oldSlot
      : newConfig.migrateSlotKey(oldSlot)
  }
  plugin.settings.slotKeys = migratedSlotKeys
  plugin.settings.customSections = newBoundaries

  await plugin.saveSettings()
  await notifySectionSettingsChanged(plugin.app)
}
