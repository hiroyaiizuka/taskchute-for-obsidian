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
}

export function createFakeLicenseManager(active = true): FakeLicenseManager {
  let value = active

  return {
    isActive: () => value,
    setActive: (next: boolean) => {
      value = next
    },
  }
}
