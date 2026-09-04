import type { LocaleKey } from '../../i18n'

/**
 * Build-time constants for the license feature.
 *
 * The public key is safe to ship: it can only verify tokens, never issue them.
 * The private key and the activation-code HMAC secret live exclusively in the
 * license API's Cloudflare secrets.
 */

/**
 * Ed25519 public key (base64url, raw 32 bytes) matching the deployed Worker's
 * LICENSE_PRIVATE_KEY.
 *
 * Rotating the pair means updating both sides together: the license repo's
 * `npm run keys:generate` rewrites this constant and `npm run keys:upload` puts
 * the private half into Cloudflare secrets. Skip either and the Worker keeps
 * signing while every user is rejected with `invalid-signature`. The generator
 * rewrites this line by regex, so keep the declaration shaped as
 * `export const LICENSE_PUBLIC_KEY = '…'`.
 */
export const LICENSE_PUBLIC_KEY = 'YTWhN3Bl5zorbd6wJVRUF50CDee7hSPseXZiUHMoI0I'

/** Baked into the token payload (`p`) and the license-id derivation. */
export const LICENSE_PRODUCT_ID = 'taskchute-plus'

export const LICENSE_API_BASE = 'https://taskchute-license.levers.workers.dev'

/**
 * Refresh once the token has less than this long to live. Comfortably shorter
 * than the server's 7-day TTL, so a week of failed refreshes still leaves the
 * user working.
 */
export const LICENSE_REFRESH_THRESHOLD_SEC = 24 * 60 * 60

/** How often to re-check whether a refresh is due, while Obsidian stays open. */
export const LICENSE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * Floor between two device-presence checks. The check runs whenever the settings
 * tab builds its definitions — again after every control change — so without a
 * floor, a few seconds of fiddling becomes a burst of requests.
 */
export const LICENSE_DEVICE_CHECK_MIN_INTERVAL_SEC = 60

/**
 * Waits before each retry of a token *renewal* whose answer may have been lost.
 * One entry per retry, so this also sets how many there are.
 *
 * The server commits the rotation before answering, so a request that never came
 * back may still have spent this device's secret. Presenting the same secret
 * again inside the server's grace window (`REFRESH_GRACE_SEC`) is the only way
 * to learn the replacement — miss it and the user has to re-enter the code —
 * hence retrying at once rather than twelve hours later.
 */
export const LICENSE_ISSUE_RETRY_BACKOFF_MS = [1_000, 3_000]

/**
 * Cap on a single attempt. `requestUrl` takes no timeout and cannot be aborted,
 * so without this one hung request would swallow the whole window.
 */
export const LICENSE_ISSUE_ATTEMPT_TIMEOUT_MS = 15_000

/**
 * How long after the first attempt a retry may still start. Has to fit inside
 * the grace window with room for the attempt that follows and the server's own
 * clock: a retry landing after the window closes only spends a request to be
 * told the same thing.
 */
export const LICENSE_ISSUE_RETRY_DEADLINE_MS = 45_000

/**
 * Reject a stored token when the local clock has rewound at least this far
 * behind the last time the server told us (SPEC 11-5). Offline verification
 * trusts the device clock, so winding it back would otherwise defeat expiry.
 */
export const LICENSE_CLOCK_ROLLBACK_TOLERANCE_SEC = 24 * 60 * 60

/**
 * Guide page for buying and activating a Pro license, shown next to the
 * activation form. The site serves Japanese under `/ja/`.
 */
const LICENSE_PURCHASE_URL = 'https://obsidian.levers.co.jp/howto/pro-license'
const LICENSE_PURCHASE_URL_JA =
  'https://obsidian.levers.co.jp/ja/howto/pro-license'

export function licensePurchaseUrl(locale: LocaleKey): string {
  return locale === 'ja' ? LICENSE_PURCHASE_URL_JA : LICENSE_PURCHASE_URL
}
