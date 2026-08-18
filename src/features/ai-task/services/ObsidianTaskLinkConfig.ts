/**
 * Obsidian task-click linkage frontmatter reader and title matching.
 *
 * The configured title is normalized once when read. The started task title
 * is deliberately kept verbatim: matching mirrors TaskChute for Agents,
 * including case-sensitive exact matching and one-way contains semantics.
 */

import type { ObsidianTaskLinkConfig } from '../../../types/TaskFields'

const VALID_MATCH_TYPES = new Set(['exact', 'contains'])

/** Validate the persisted `obsidian_sync` object without mutating it. */
export function isObsidianTaskLinkConfig(
  value: unknown,
): value is ObsidianTaskLinkConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const config = value as Record<string, unknown>
  return (
    typeof config['enabled'] === 'boolean' &&
    typeof config['taskTitle'] === 'string' &&
    config['taskTitle'].trim().length > 0 &&
    typeof config['matchType'] === 'string' &&
    VALID_MATCH_TYPES.has(config['matchType'])
  )
}

/**
 * Read the active linkage config from task frontmatter.
 * Disabled, missing, or malformed values are represented by `null`.
 */
export function readObsidianTaskLinkConfig(
  frontmatter: Record<string, unknown> | null | undefined,
): ObsidianTaskLinkConfig | null {
  if (!frontmatter || typeof frontmatter !== 'object') return null

  const config = frontmatter['obsidian_sync']
  if (!isObsidianTaskLinkConfig(config) || !config.enabled) return null

  return {
    enabled: true,
    taskTitle: config.taskTitle.trim(),
    matchType: config.matchType,
  }
}

/**
 * Match a started human-task title against a linkage config.
 * `contains` is intentionally one-way: source title contains configured title.
 */
export function matchesObsidianTaskTitle(
  sourceTaskTitle: string,
  config: ObsidianTaskLinkConfig,
): boolean {
  if (!isObsidianTaskLinkConfig(config) || !config.enabled) return false

  const configuredTitle = config.taskTitle.trim()
  if (config.matchType === 'exact') {
    return sourceTaskTitle === configuredTitle
  }
  return sourceTaskTitle.includes(configuredTitle)
}
