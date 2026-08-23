/**
 * Signs tokens the way the license API does, so manager tests can exercise
 * real verification instead of stubbing it out.
 *
 * Mirrors apps/api/src/license/token.ts#signToken. Kept beside the golden
 * vector: if the two ever disagree, the golden vector test is the arbiter.
 */
import { ed25519 } from '@noble/curves/ed25519'

import { GOLDEN_PUBLIC_KEY } from '../../../src/features/license/token/goldenVector'
import { TOKEN_KEY_ORDER, TOKEN_PREFIX } from '../../../src/features/license/token/token'

/** The 32-byte sequence 0x00..0x1F, matching GOLDEN_PUBLIC_KEY. */
const TEST_PRIVATE_KEY = new Uint8Array(32).map((_, index) => index)

export const TEST_PUBLIC_KEY = GOLDEN_PUBLIC_KEY

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface SignTestTokenInput {
  licenseId?: string
  deviceId: string
  productId?: string
  issuedAt: number
  expiresAt: number
  maxDevices?: number
}

export function signTestToken(input: SignTestTokenInput): string {
  const payload: Record<string, unknown> = {
    v: 1,
    lid: input.licenseId ?? 'TESTLICENSE00001',
    did: input.deviceId,
    p: input.productId ?? 'taskchute-plus',
    iat: input.issuedAt,
    exp: input.expiresAt,
    md: input.maxDevices ?? 3,
  }

  const parts: string[] = []
  for (const key of TOKEN_KEY_ORDER) {
    const value = payload[key]
    if (value === undefined || value === '') continue
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`)
  }

  const encoder = new TextEncoder()
  const payloadB64 = base64url(encoder.encode(`{${parts.join(',')}}`))
  const signature = ed25519.sign(
    encoder.encode(`${TOKEN_PREFIX}.${payloadB64}`),
    TEST_PRIVATE_KEY,
  )

  return `${TOKEN_PREFIX}.${payloadB64}.${base64url(signature)}`
}
