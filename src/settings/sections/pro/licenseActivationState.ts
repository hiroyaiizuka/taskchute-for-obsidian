import type { ActivationFailure } from "../../../features/license/services/LicenseManager"

/**
 * The activation form between renders.
 *
 * The code being typed is not persisted — an unactivated code is not a setting —
 * and the failure message and its seat list are rebuilt from here rather than
 * poked into the DOM, because both live on rows the framework owns.
 */
export class LicenseActivationState {
  code: string | undefined
  activating = false
  errorDesc = ""
  deviceLimitFailure: Extract<
    ActivationFailure,
    { kind: "device-limit" }
  > | null = null

  /** Falls back to the stored code the first time the form is drawn. */
  currentCode(stored: string | undefined): string {
    return this.code ?? stored ?? ""
  }

  beginActivation(): void {
    this.activating = true
    this.errorDesc = ""
    this.deviceLimitFailure = null
  }

  failActivation(message: string, failure: ActivationFailure): void {
    this.activating = false
    this.errorDesc = message
    this.deviceLimitFailure =
      failure.kind === "device-limit" ? failure : null
  }

  /** A freed seat makes a "limit reached" message stale. */
  clearError(): void {
    this.errorDesc = ""
    this.deviceLimitFailure = null
  }

  reset(): void {
    this.code = undefined
    this.activating = false
    this.clearError()
  }
}
