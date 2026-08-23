/**
 * Golden vector for the auth-token format.
 *
 * The issuer (license API) and this plugin sign and verify the same bytes but
 * live in separate repositories, so nothing but a shared fixed vector can catch
 * a drift in the canonical serialization or in the signed message. If the test
 * that consumes this file fails, every token already issued in production is
 * about to become unverifiable — fix the serializer, never the vector.
 *
 * The private key behind GOLDEN_PUBLIC_KEY is the 32-byte sequence 0x00..0x1F.
 * It is deliberately public and signs nothing but this vector.
 *
 * The identical constants must exist in
 * taskchute-for-obsidian-license/apps/api (SPEC 11-7).
 */

export const GOLDEN_PUBLIC_KEY = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg'

/** The exact bytes the issuer serializes, before base64url encoding. */
export const GOLDEN_CANONICAL_JSON =
  '{"v":1,"lid":"8F3K2M9QX7RD4WPZ","did":"DEVICE-GOLDEN-0001","p":"taskchute-plus","iat":1787000000,"exp":1787604800,"md":3}'

export const GOLDEN_TOKEN =
  'TCPT1.eyJ2IjoxLCJsaWQiOiI4RjNLMk05UVg3UkQ0V1BaIiwiZGlkIjoiREVWSUNFLUdPTERFTi0wMDAxIiwicCI6InRhc2tjaHV0ZS1wbHVzIiwiaWF0IjoxNzg3MDAwMDAwLCJleHAiOjE3ODc2MDQ4MDAsIm1kIjozfQ.GNu-3Ftqo52Ha38Si0ALg2R1YoDdLrh3QzzhDxLZ1CQjjuhepdSIcio_T2eo0dLXw6izBPnMOOp1n5Np3HrGCg'

export const GOLDEN_PAYLOAD = {
  v: 1,
  lid: '8F3K2M9QX7RD4WPZ',
  did: 'DEVICE-GOLDEN-0001',
  p: 'taskchute-plus',
  iat: 1787000000,
  exp: 1787604800,
  md: 3,
} as const

/** A time comfortably inside the vector's validity window. */
export const GOLDEN_NOW = 1787100000
