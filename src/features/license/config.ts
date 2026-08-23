import type { LocaleKey } from '../../i18n'

/**
 * Build-time constants for the license feature.
 *
 * The public key is safe to ship: it can only verify tokens, never issue them.
 * The private key and the activation-code HMAC secret live exclusively in the
 * license API's Cloudflare secrets.
 */

/**
 * Ed25519 public key (base64url, raw 32 bytes) matching the API's
 * LICENSE_PRIVATE_KEY.
 *
 * ⚠️ This is currently the key from the API repo's local .dev.vars. The
 * deployed Worker's LICENSE_PRIVATE_KEY is a Cloudflare secret and its public
 * counterpart is not recorded in wrangler.jsonc, so it must be derived and
 * pasted here before a production release — otherwise every real token fails
 * verification with `invalid-signature`.
 */
export const LICENSE_PUBLIC_KEY = 'be-8ZHqidokTIubfzpcEUfk5hZbSQYGn6GyHU1nSrKg'

/** Baked into the token payload (`p`) and the license-id derivation. */
export const LICENSE_PRODUCT_ID = 'taskchute-plus'

export const LICENSE_API_BASE = 'https://taskchute-license.ancient-truth-f5b4.workers.dev'

/**
 * Refresh once the token has less than this long to live. Comfortably shorter
 * than the server's 7-day TTL, so a week of failed refreshes still leaves the
 * user working.
 */
export const LICENSE_REFRESH_THRESHOLD_SEC = 24 * 60 * 60

/** How often to re-check whether a refresh is due, while Obsidian stays open. */
export const LICENSE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * Reject a stored token when the local clock has rewound at least this far
 * behind the last time the server told us (SPEC 11-5). Offline verification
 * trusts the device clock, so winding it back would otherwise defeat expiry.
 */
export const LICENSE_CLOCK_ROLLBACK_TOLERANCE_SEC = 24 * 60 * 60

/**
 * Landing page where a license can be bought, shown next to the activation
 * form so someone without a code has somewhere to go. The site serves its
 * Japanese pages under `/ja/`, so Japanese users are sent straight there
 * rather than to the English root.
 */
const LICENSE_PURCHASE_URL = 'https://obsidian.levers.co.jp/'
const LICENSE_PURCHASE_URL_JA = 'https://obsidian.levers.co.jp/ja/'

export function licensePurchaseUrl(locale: LocaleKey): string {
  return locale === 'ja' ? LICENSE_PURCHASE_URL_JA : LICENSE_PURCHASE_URL
}
