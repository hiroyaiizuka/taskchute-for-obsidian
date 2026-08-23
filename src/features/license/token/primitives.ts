/**
 * Low-level encoding and key handling for auth-token verification.
 *
 * PORTED from the license API repository
 * (taskchute-for-obsidian-license/apps/api/src/license/primitives.ts).
 * The two repositories cannot share code, so this is a deliberate copy of the
 * verification-side subset only: the signing side (HMAC derivation, key
 * generation) stays on the server and must never appear here.
 *
 * Keep the dependency surface at @noble/* so the byte behaviour matches the
 * issuer exactly. A one-byte divergence invalidates every issued token.
 */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value)
}

export function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return textDecoder.decode(bytes)
  } catch {
    return null
  }
}

/**
 * Decode base64url (RFC 4648 section 5, unpadded). Returns null on malformed
 * input because tokens are untrusted external data, not a configuration error.
 * Standard base64 `+/` is accepted too, to absorb copy-paste mix-ups.
 */
export function decodeBase64Url(input: string): Uint8Array | null {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return null
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) return null

  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')

  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return bytes
}

export const PUBLIC_KEY_BYTES = 32
export const SIGNATURE_BYTES = 64

/**
 * Turn a base64url key back into bytes. Throws on a bad length because the
 * public key is a build-time constant, not user input: failing loudly during
 * development beats silently rejecting every token in production.
 */
export function importKey(keyB64: string, expectedBytes: number): Uint8Array {
  const bytes = decodeBase64Url(keyB64.trim())
  if (bytes === null) {
    throw new Error('License key is not valid base64url')
  }
  if (bytes.length !== expectedBytes) {
    throw new Error(
      `License key has the wrong length: ${bytes.length} bytes (expected ${expectedBytes})`,
    )
  }
  return bytes
}

/** Format an id for display in 4-character groups (e.g. 8F3K-2M9Q-X7RD-4WPZ). */
export function formatLicenseId(licenseId: string): string {
  return (licenseId.match(/.{1,4}/g) ?? [licenseId]).join('-')
}
