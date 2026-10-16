/**
 * Auth-token verification (Ed25519).
 *
 * PORTED from the license API repository
 * (taskchute-for-obsidian-license/apps/api/src/license/token.ts). Only the
 * verification half is copied; signToken and the key generation stay server-side.
 *
 * The plugin decides entitlement by verifying this token with an embedded
 * public key. No network call is involved, so the feature keeps working while
 * offline until the token expires.
 *
 * TWO THINGS MUST NEVER DRIFT FROM THE ISSUER:
 *   1. the signed message is `${TOKEN_PREFIX}.${payloadB64}`, not the payload alone
 *   2. the canonical key order below
 * A one-byte divergence makes every issued token unverifiable. The golden
 * vector test (tests/features/license/token-golden.test.ts) exists to catch it.
 */
import { ed25519 } from '@noble/curves/ed25519'

import {
  decodeBase64Url,
  importKey,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  utf8Decode,
  utf8Encode,
} from './primitives'

/** Token prefix, so a token can never be mistaken for an activation code. */
export const TOKEN_PREFIX = 'TCPT1'

export const TOKEN_PAYLOAD_VERSION = 1 as const

export interface TokenPayload {
  /** Payload format version */
  readonly v: typeof TOKEN_PAYLOAD_VERSION
  /** License id */
  readonly lid: string
  /** Device id */
  readonly did: string
  /** Product id */
  readonly p: string
  /** Issued at (unix seconds) */
  readonly iat: number
  /** Expiry (unix seconds) */
  readonly exp: number
  /** Max devices, for display */
  readonly md: number
}

/**
 * Canonical output key order. Changing this invalidates every issued token.
 * Kept here even though the plugin never serializes, so the golden vector test
 * can assert the shared contract from this side too.
 */
export const TOKEN_KEY_ORDER = ['v', 'lid', 'did', 'p', 'iat', 'exp', 'md'] as const

/** Interpret JSON as a payload. Returns null when the shape does not match. */
export function parseTokenPayload(json: string): TokenPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null

  const record = raw as Record<string, unknown>
  if (record['v'] !== TOKEN_PAYLOAD_VERSION) return null

  const lid = record['lid']
  const did = record['did']
  const p = record['p']
  const iat = record['iat']
  const exp = record['exp']
  const md = record['md']

  for (const value of [lid, did, p]) {
    if (typeof value !== 'string' || value.length === 0) return null
  }
  for (const value of [iat, exp, md]) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  }

  return {
    v: TOKEN_PAYLOAD_VERSION,
    lid: lid as string,
    did: did as string,
    p: p as string,
    iat: iat as number,
    exp: exp as number,
    md: md as number,
  }
}

export type TokenVerifyError =
  | 'malformed'
  | 'unsupported-format'
  | 'invalid-encoding'
  | 'invalid-signature'
  | 'invalid-payload'
  | 'product-mismatch'
  | 'device-mismatch'
  | 'expired'

export type TokenVerifyResult =
  | { readonly ok: true; readonly token: TokenPayload }
  | { readonly ok: false; readonly error: TokenVerifyError }

export interface VerifyTokenOptions {
  readonly productId: string
  /** Verification time (unix seconds) */
  readonly now: number
  /** Bind to a device; the plugin always passes its own device id */
  readonly deviceId?: string
  /** Clock-skew tolerance in seconds. Default 300 */
  readonly leewaySec?: number
}

export const DEFAULT_LEEWAY_SEC = 300

/**
 * Verify an auth token. Performs no network I/O.
 *
 * Expiry depends on the local clock, hence the leeway. A large deliberate
 * rollback is the caller's to catch, against the last known server time
 * (see LicenseStore / SPEC 11-5).
 */
export function verifyToken(
  publicKeyB64: string,
  token: string,
  options: VerifyTokenOptions,
): TokenVerifyResult {
  const parts = token.trim().replace(/\s+/g, '').split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed' }

  const [prefix, payloadB64, signatureB64] = parts as [string, string, string]
  if (prefix.length === 0 || payloadB64.length === 0 || signatureB64.length === 0) {
    return { ok: false, error: 'malformed' }
  }
  if (prefix !== TOKEN_PREFIX) return { ok: false, error: 'unsupported-format' }

  const signature = decodeBase64Url(signatureB64)
  if (signature === null || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, error: 'invalid-encoding' }
  }

  const payloadBytes = decodeBase64Url(payloadB64)
  if (payloadBytes === null) return { ok: false, error: 'invalid-encoding' }

  const publicKey = importKey(publicKeyB64, PUBLIC_KEY_BYTES)

  let signatureValid: boolean
  try {
    signatureValid = ed25519.verify(
      signature,
      utf8Encode(`${TOKEN_PREFIX}.${payloadB64}`),
      publicKey,
    )
  } catch {
    // Invalid points and non-canonical scalars can throw
    signatureValid = false
  }
  if (!signatureValid) return { ok: false, error: 'invalid-signature' }

  const json = utf8Decode(payloadBytes)
  if (json === null) return { ok: false, error: 'invalid-payload' }

  const payload = parseTokenPayload(json)
  if (payload === null) return { ok: false, error: 'invalid-payload' }

  if (payload.p !== options.productId) return { ok: false, error: 'product-mismatch' }
  if (options.deviceId !== undefined && payload.did !== options.deviceId) {
    return { ok: false, error: 'device-mismatch' }
  }

  const leeway = options.leewaySec ?? DEFAULT_LEEWAY_SEC
  if (payload.exp + leeway < options.now) return { ok: false, error: 'expired' }

  return { ok: true, token: payload }
}
