/**
 * The single fake used wherever a test host needs to look licensed.
 *
 * createAiTaskManager gained a license gate, and roughly 70 AI task suites
 * build their own plugin stub. Keeping the fake in one place means a future
 * change to the gate's shape is one edit, not seventy.
 */
export interface FakeLicenseManager {
  isActive: () => boolean
  setActive: (active: boolean) => void
  /** The settings tab picks its shape from the state, not from isActive(). */
  getState: () => { status: 'active' | 'inactive' }
  getLicenseSummary: () => undefined
  /**
   * The code the settings screen may show. A real manager hides it once this
   * device has given up its seat; the fake is never in that position, so it
   * reports whatever the caller stored.
   */
  getStoredCode: () => string | undefined
  setStoredCode: (code: string | undefined) => void
  isSeatReleased: () => boolean
  syncFromServer: () => Promise<{ status: 'active' | 'inactive' }>
}

export function createFakeLicenseManager(active = true): FakeLicenseManager {
  let value = active
  let code: string | undefined

  const getState = (): { status: 'active' | 'inactive' } => ({
    status: value ? 'active' : 'inactive',
  })

  return {
    isActive: () => value,
    setActive: (next: boolean) => {
      value = next
    },
    getState,
    getLicenseSummary: () => undefined,
    getStoredCode: () => code,
    setStoredCode: (next: string | undefined) => {
      code = next
    },
    isSeatReleased: () => false,
    syncFromServer: () => Promise.resolve(getState()),
  }
}
