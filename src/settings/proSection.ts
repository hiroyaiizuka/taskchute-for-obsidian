import { Platform } from "obsidian"
import { isAiTaskLicensed } from "../features/ai-task/availability"
import type { SectionContext } from "./types"

/**
 * Whether this platform has anything a Pro license could unlock.
 *
 * AI tasks are the only thing it buys — `isProLicenseActive` is literally the
 * AI entitlement — and they spawn a local CLI, which
 * `evaluateAiTaskAvailability` refuses on mobile as `not-desktop`. Activating
 * from an iPad would therefore unlock nothing, so the section stays off there:
 * both the license form and the AI settings behind it. A seat activated from a
 * desktop is still released from the device list on a desktop.
 */
export function isProSectionSupported(): boolean {
  return Platform.isDesktop
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
