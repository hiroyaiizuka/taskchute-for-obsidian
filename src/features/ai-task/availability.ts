/**
 * AI Task - the single source of truth for "is the AI feature on?".
 *
 * The answer used to be spelled out in five different places (the factory, the
 * license gate, the ambient runtime, the view, the add-task modal), and one of
 * them had drifted: the add-task modal checked settings and platform but never
 * the license, so an unlicensed vault carrying `aiTaskEnabled: true` still
 * showed the human/AI task type selector. Every gate now lives here.
 *
 * Deliberately NOT one boolean. Callers ask genuinely different questions —
 * the settings tab renders the AI section whenever the license is active even
 * though the toggle is off — so each question gets its own name.
 *
 * This module must never import ./index: the factory imports it, and the cycle
 * would leave `createAiTaskManager` undefined at module-eval time.
 */

import { Platform } from 'obsidian'
import type { PathManagerLike, TaskChuteSettings } from '../../types'

/**
 * Structural host. Both AiTaskPluginLike and TaskChutePluginLike satisfy it,
 * and a test stub only needs the fields for the gate it exercises.
 */
export interface AiTaskAvailabilityHost {
  settings: Pick<TaskChuteSettings, 'aiTaskEnabled'>
  pathManager?: Partial<Pick<PathManagerLike, 'getAiLogsPath' | 'getAiLogsMonthPath'>>
  /** Entitlement gate; structural so tests fake it with a single method. */
  licenseManager?: { isActive: () => boolean }
  /** Present only once the runtime has actually been built. */
  aiTaskManager?: unknown
}

export type AiTaskUnavailableReason =
  /** The settings toggle is off. */
  | 'disabled'
  /** Mobile: there is no local CLI to spawn. */
  | 'not-desktop'
  /** No active license. */
  | 'unlicensed'
  /** The path manager predates the AI log paths (lightweight stubs). */
  | 'unsupported-paths'

export type AiTaskAvailability =
  | { available: true }
  | { available: false; reason: AiTaskUnavailableReason }

const AVAILABLE: AiTaskAvailability = { available: true }

/** Whether the user turned the feature on, ignoring entitlement and platform. */
export function isAiTaskSettingEnabled(host: AiTaskAvailabilityHost): boolean {
  return host.settings.aiTaskEnabled === true
}

/**
 * Whether the license is active, ignoring the settings toggle. The Pro
 * settings section needs this on its own: it renders the AI toggle, so it
 * cannot depend on that toggle already being on.
 */
export function isAiTaskLicensed(host: AiTaskAvailabilityHost): boolean {
  return host.licenseManager?.isActive() === true
}

/**
 * Evaluate every gate, in the order the factory used to. The reason is what
 * lets callers log or explain the refusal instead of failing silently.
 */
export function evaluateAiTaskAvailability(
  host: AiTaskAvailabilityHost,
): AiTaskAvailability {
  if (!isAiTaskSettingEnabled(host)) return { available: false, reason: 'disabled' }
  if (!Platform?.isDesktop) return { available: false, reason: 'not-desktop' }
  if (!isAiTaskLicensed(host)) return { available: false, reason: 'unlicensed' }

  const pathManager = host.pathManager
  if (
    typeof pathManager?.getAiLogsPath !== 'function' ||
    typeof pathManager?.getAiLogsMonthPath !== 'function'
  ) {
    return { available: false, reason: 'unsupported-paths' }
  }

  return AVAILABLE
}

/**
 * Whether a runtime may be built. Used by the factory and the license gate,
 * i.e. by the code that decides whether `aiTaskManager` should exist at all.
 */
export function canStartAiTaskRuntime(host: AiTaskAvailabilityHost): boolean {
  return evaluateAiTaskAvailability(host).available
}

/**
 * The predicate every UI surface uses. Stricter than "a manager exists" on
 * purpose: a gate that has just closed (toggle off, license revoked) hides the
 * AI UI on the very next render, without waiting for the teardown to land.
 */
export function isAiTaskFeatureAvailable(host: AiTaskAvailabilityHost): boolean {
  return host.aiTaskManager !== undefined && canStartAiTaskRuntime(host)
}
