import { isAiTaskLicensed } from "../features/ai-task/availability"
import type { SectionContext } from "./types"

/**
 * AI tasks are still in preparation, so the Pro section — the license form and
 * the AI settings it unlocks — stays hidden until the version row is clicked
 * this many times. Only for vaults without a license; an active one shows the
 * section outright.
 */
export const PRO_SECTION_UNLOCK_CLICKS = 10

/**
 * The click unlock, kept on the tab instance so it lapses after a reload.
 * Only ever matters without a license: an active one shows the section on its
 * own, and losing it hides the section again.
 */
export class ProUnlockState {
  private unlocked = false
  private clicks = 0

  /** Counts one click; returns true when this click crossed the threshold. */
  registerClick(): boolean {
    this.clicks += 1
    if (this.clicks < PRO_SECTION_UNLOCK_CLICKS) return false
    this.unlocked = true
    this.clicks = 0
    return true
  }

  get isUnlocked(): boolean {
    return this.unlocked
  }
}

/**
 * Whether to draw the Pro section.
 *
 * The hidden click unlock is for people who do not have a license yet, so it
 * must not be the only way in: once a license is active the section is the only
 * place to manage seats and AI settings, and re-discovering the unlock after
 * every reload would strand a paying user.
 *
 * Deliberately not latched on the license either: releasing this device drops
 * the state back to unlicensed, and the section has to disappear with it rather
 * than leave an activation form behind for a feature that is hidden again.
 */
export function isProSectionVisible(
  ctx: SectionContext,
  unlock: ProUnlockState,
): boolean {
  if (unlock.isUnlocked) return true
  return isProLicenseActive(ctx)
}

/**
 * The entitlement gate for everything in the Pro section.
 *
 * Routed through the AI availability module rather than reading the license
 * state here: that module is the single source of truth for "is the feature
 * on?", and the settings tab has to agree with the runtime it configures.
 */
export function isProLicenseActive(ctx: SectionContext): boolean {
  return isAiTaskLicensed(ctx.plugin)
}
