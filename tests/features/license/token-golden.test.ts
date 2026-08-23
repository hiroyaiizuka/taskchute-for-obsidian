/**
 * Byte-compatibility guard for the auth-token format.
 *
 * This is the highest-priority test in the license feature: if it fails, the
 * plugin can no longer verify tokens the server already issued. Fix the
 * verifier, never the vector.
 */
import {
  GOLDEN_CANONICAL_JSON,
  GOLDEN_NOW,
  GOLDEN_PAYLOAD,
  GOLDEN_PUBLIC_KEY,
  GOLDEN_TOKEN,
} from '../../../src/features/license/token/goldenVector'
import { decodeBase64Url, utf8Decode } from '../../../src/features/license/token/primitives'
import {
  parseTokenPayload,
  TOKEN_KEY_ORDER,
  verifyToken,
} from '../../../src/features/license/token/token'

const PRODUCT_ID = 'taskchute-plus'

describe('auth token golden vector', () => {
  it('verifies the vector signed by the issuer', () => {
    const result = verifyToken(GOLDEN_PUBLIC_KEY, GOLDEN_TOKEN, {
      productId: PRODUCT_ID,
      now: GOLDEN_NOW,
      deviceId: GOLDEN_PAYLOAD.did,
    })

    expect(result).toEqual({ ok: true, token: GOLDEN_PAYLOAD })
  })

  it('carries the canonical serialization the issuer produced', () => {
    const payloadB64 = GOLDEN_TOKEN.split('.')[1]
    const bytes = decodeBase64Url(payloadB64)
    expect(bytes).not.toBeNull()

    // Compared as a string, not as parsed JSON: key order and spacing are the
    // part of the contract that a JSON comparison would silently accept.
    expect(utf8Decode(bytes as Uint8Array)).toBe(GOLDEN_CANONICAL_JSON)
  })

  it('keeps the canonical key order', () => {
    expect(TOKEN_KEY_ORDER).toEqual(['v', 'lid', 'did', 'p', 'iat', 'exp', 'md'])
    expect(Object.keys(JSON.parse(GOLDEN_CANONICAL_JSON))).toEqual([...TOKEN_KEY_ORDER])
  })

  it('signs `TCPT1.<payload>`, not the payload alone', () => {
    // Tamper with the prefix only. If the verifier ever signed the bare
    // payload, swapping the prefix would still verify.
    const [, payloadB64, signatureB64] = GOLDEN_TOKEN.split('.')
    const result = verifyToken(GOLDEN_PUBLIC_KEY, `TCPT2.${payloadB64}.${signatureB64}`, {
      productId: PRODUCT_ID,
      now: GOLDEN_NOW,
    })

    expect(result).toEqual({ ok: false, error: 'unsupported-format' })
  })
})

describe('verifyToken rejections', () => {
  const base = { productId: PRODUCT_ID, now: GOLDEN_NOW } as const

  it('rejects a token bound to another device', () => {
    expect(
      verifyToken(GOLDEN_PUBLIC_KEY, GOLDEN_TOKEN, { ...base, deviceId: 'DEVICE-OTHER-0002' }),
    ).toEqual({ ok: false, error: 'device-mismatch' })
  })

  it('rejects a token issued for another product', () => {
    expect(verifyToken(GOLDEN_PUBLIC_KEY, GOLDEN_TOKEN, { ...base, productId: 'other' })).toEqual({
      ok: false,
      error: 'product-mismatch',
    })
  })

  it('rejects an expired token past the leeway', () => {
    expect(
      verifyToken(GOLDEN_PUBLIC_KEY, GOLDEN_TOKEN, { ...base, now: GOLDEN_PAYLOAD.exp + 301 }),
    ).toEqual({ ok: false, error: 'expired' })
  })

  it('accepts a token inside the clock-skew leeway', () => {
    const result = verifyToken(GOLDEN_PUBLIC_KEY, GOLDEN_TOKEN, {
      ...base,
      now: GOLDEN_PAYLOAD.exp + 299,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a payload whose signature was not recomputed', () => {
    const [prefix, , signatureB64] = GOLDEN_TOKEN.split('.')
    const forged = { ...GOLDEN_PAYLOAD, md: 99 }
    const forgedB64 = Buffer.from(JSON.stringify(forged))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(verifyToken(GOLDEN_PUBLIC_KEY, `${prefix}.${forgedB64}.${signatureB64}`, base)).toEqual({
      ok: false,
      error: 'invalid-signature',
    })
  })

  it('rejects a token verified against a different public key', () => {
    // Same length, different key: must fail on the signature, not on import.
    const otherKey = 'A'.repeat(43)
    expect(verifyToken(otherKey, GOLDEN_TOKEN, base)).toEqual({
      ok: false,
      error: 'invalid-signature',
    })
  })

  it.each([
    ['not-a-token', 'malformed'],
    ['TCPT1.only-two-parts', 'malformed'],
    ['TCPT1..sig', 'malformed'],
    ['TCPT1.payload.$$$', 'invalid-encoding'],
  ])('rejects %s', (token, error) => {
    expect(verifyToken(GOLDEN_PUBLIC_KEY, token, base)).toEqual({ ok: false, error })
  })
})

describe('parseTokenPayload', () => {
  it.each([
    ['not json', 'nope'],
    ['an array', '[]'],
    ['a wrong version', '{"v":2,"lid":"a","did":"b","p":"c","iat":1,"exp":2,"md":3}'],
    ['an empty string field', '{"v":1,"lid":"","did":"b","p":"c","iat":1,"exp":2,"md":3}'],
    ['a negative number', '{"v":1,"lid":"a","did":"b","p":"c","iat":-1,"exp":2,"md":3}'],
    ['a fractional number', '{"v":1,"lid":"a","did":"b","p":"c","iat":1.5,"exp":2,"md":3}'],
    ['a missing field', '{"v":1,"lid":"a","did":"b","p":"c","iat":1,"exp":2}'],
  ])('returns null for %s', (_label, json) => {
    expect(parseTokenPayload(json)).toBeNull()
  })
})
