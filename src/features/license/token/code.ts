/**
 * Activation-code normalization.
 *
 * PORTED from the license API repository
 * (taskchute-for-obsidian-license/apps/api/src/license/code.ts), minus the HMAC
 * derivation, which requires a secret the plugin must never hold.
 *
 * The server normalizes exactly the same way, so this is purely a pre-flight
 * check: catching a typo locally avoids a pointless round trip. Anything that
 * passes here is still sent raw and re-validated server-side.
 */

/**
 * Crockford Base32 (I / L / O / U removed) — the characters that are hard to
 * confuse when read aloud or copied by hand.
 */
export const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const CODE_PREFIX = 'TCP'

/** Body length in Crockford Base32 characters (80 bits). */
export const CODE_LENGTH = 16

/** Format for display, in 4-character groups (e.g. TCP-8F3K-2M9Q-X7RD-4WPZ). */
export function formatActivationCode(raw: string): string {
  const groups = raw.match(/.{1,4}/g) ?? [raw]

  return [CODE_PREFIX, ...groups].join('-')
}

/**
 * Reduce a code the user typed or pasted to its comparable form.
 *
 * Absorbs surrounding whitespace, lowercase, omitted hyphens and an omitted
 * prefix. Following Crockford, `I` / `L` read as `1` and `O` as `0`.
 *
 * Returns null when the input cannot be a code at all; callers treat that as a
 * typo rather than as a rejected license.
 */
export function normalizeCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '')

  // The prefix is optional. Decided by length, so a body that happens to start
  // with TCP is not truncated by mistake.
  const withoutPrefix =
    compact.length === CODE_PREFIX.length + CODE_LENGTH && compact.startsWith(CODE_PREFIX)
      ? compact.slice(CODE_PREFIX.length)
      : compact

  const body = withoutPrefix.replace(/[IL]/g, '1').replace(/O/g, '0')

  if (body.length !== CODE_LENGTH) return null
  for (const char of body) {
    if (!BASE32_ALPHABET.includes(char)) return null
  }

  return body
}
