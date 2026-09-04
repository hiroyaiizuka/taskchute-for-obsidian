/**
 * Turn a license failure into text for the user.
 *
 * Localized from the API's stable `error` code, never from its `message`: that
 * field is Japanese prose and would leak into an English UI. The server text is
 * kept only as a last resort for a code this build does not recognize.
 *
 * Every message carries its code. The prose is what the user acts on, but the
 * code is what support asks for and what a bug report has to contain, and a
 * failure that reaches the screen without one leaves both sides guessing.
 */
import { t } from '../../../i18n'
import type { ActivationFailure } from '../services/LicenseManager'
import type { LicenseApiFailure } from '../services/LicenseApiClient'

const FALLBACKS: Record<string, string> = {
  malformed_code: 'That does not look like an activation code. Check it and try again.',
  invalid_code: 'This activation code was not found. Check it and try again.',
  license_revoked: 'This license has been revoked. Please contact support.',
  license_expired: 'This license has expired. Please renew it to keep using AI tasks.',
  license_suspended: 'This license is suspended. Please contact support.',
  stale_secret:
    'This device is no longer the one registered to your license. Enter your activation code again to use it here.',
  reset_limit_reached:
    'This license has been re-registered on too many devices recently. Please contact support.',
  device_limit_reached:
    'You have reached the maximum number of devices. Release one to activate this device.',
  device_not_found: 'That device is no longer registered.',
  deactivation_limit_reached:
    'You have released too many devices recently. Try again after {retryAt}.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
  upstream_unavailable: 'The license service is temporarily unavailable. Try again later.',
  internal: 'The license service returned an unexpected error. Try again later.',
  network: 'Could not reach the license service. Check your connection and try again.',
  malformed: 'The license request was rejected. Please report this as a bug.',
  no_activation_code: 'Enter your activation code first.',
}

/** Codes for the failures the client itself decides, which have no server code. */
const CLIENT_CODES = {
  network: 'network_unreachable',
  malformed: 'bad_request',
  noCode: 'no_activation_code',
  untrustedToken: 'untrusted_token',
} as const

function formatRetryAt(retryAfterAt: number | undefined): string {
  if (retryAfterAt === undefined) return ''

  return new Date(retryAfterAt * 1000).toLocaleString()
}

function messageForCode(code: string, vars?: Record<string, string>): string {
  return t(`license.errors.${code}`, FALLBACKS[code] ?? FALLBACKS['internal'], vars)
}

/**
 * The message the user reads, with the code that identifies the failure.
 *
 * The code goes last and in parentheses so it never gets in the way of the
 * instruction, which is the part most users need.
 */
function withCode(message: string, code: string): string {
  return t('license.errors.withCode', '{message} (code: {code})', { message, code })
}

/**
 * The stable identifier for a failure: the server's own code where there is
 * one, and a client-side code where the request never produced an answer.
 */
export function apiFailureCode(failure: LicenseApiFailure): string {
  if (failure.kind === 'network') return CLIENT_CODES.network
  if (failure.kind === 'malformed') return `${CLIENT_CODES.malformed}_${failure.status}`
  if (failure.kind === 'no-code') return CLIENT_CODES.noCode

  return failure.code
}

export function activationFailureCode(failure: ActivationFailure): string {
  switch (failure.kind) {
    case 'invalid-input':
      return 'malformed_code'
    case 'device-limit':
      return 'device_limit_reached'
    case 'untrusted-token':
      return CLIENT_CODES.untrustedToken
    default:
      return apiFailureCode(failure)
  }
}

export function describeApiFailure(failure: LicenseApiFailure): string {
  return withCode(apiFailureMessage(failure), apiFailureCode(failure))
}

function apiFailureMessage(failure: LicenseApiFailure): string {
  if (failure.kind === 'network') return messageForCode('network')
  if (failure.kind === 'malformed') return messageForCode('malformed')
  // Not a bug to report: the user simply has nothing entered to act with.
  if (failure.kind === 'no-code') return messageForCode(CLIENT_CODES.noCode)

  if (failure.code === 'deactivation_limit_reached' || failure.code === 'reset_limit_reached') {
    return messageForCode(failure.code, { retryAt: formatRetryAt(failure.details?.retry_after_at) })
  }

  // A code this build predates: the server's own wording beats a generic one.
  if (FALLBACKS[failure.code] === undefined && failure.message !== undefined) {
    return failure.message
  }

  return messageForCode(failure.code)
}

export function describeActivationFailure(failure: ActivationFailure): string {
  return withCode(activationFailureMessage(failure), activationFailureCode(failure))
}

function activationFailureMessage(failure: ActivationFailure): string {
  switch (failure.kind) {
    case 'invalid-input':
      return messageForCode('malformed_code')
    case 'device-limit':
      return messageForCode('device_limit_reached')
    case 'untrusted-token':
      return t(
        'license.errors.untrustedToken',
        'The license service returned a token this version cannot verify. Please update the plugin.',
      )
    default:
      return apiFailureMessage(failure)
  }
}
