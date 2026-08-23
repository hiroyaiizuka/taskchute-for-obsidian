/**
 * The label is what a user reads when choosing which seat to release, so it
 * has to name both the machine and the vault — one person often runs several
 * vaults on one machine, and the same vault name exists on several machines.
 */
import { formatDeviceLabel } from '../../../src/features/license'

describe('formatDeviceLabel', () => {
  test('joins the machine and the vault', () => {
    expect(formatDeviceLabel('workbench', 'Notes')).toBe('workbench / Notes')
  })

  test('drops the .local suffix macOS reports', () => {
    expect(formatDeviceLabel('MacBook-Pro.local', 'Notes')).toBe('MacBook-Pro / Notes')
  })

  test('trims surrounding whitespace', () => {
    expect(formatDeviceLabel('  workbench  ', ' Notes ')).toBe('workbench / Notes')
  })

  test.each([
    ['a missing vault name', undefined],
    ['a blank vault name', '   '],
    ['a non-string vault name', 42],
  ])('omits %s rather than emitting a dangling separator', (_label, vault) => {
    expect(formatDeviceLabel('workbench', vault)).toBe('workbench')
  })

  test('falls back to the vault alone when the machine is unknown', () => {
    // Mobile has no require('os') and may not match a known platform.
    expect(formatDeviceLabel(undefined, 'Notes')).toBe('Notes')
  })

  test('returns undefined when nothing is knowable', () => {
    // The API treats the label as optional, so sending nothing is valid.
    expect(formatDeviceLabel(undefined, undefined)).toBeUndefined()
  })

  test('truncates to the length the API accepts', () => {
    // The API caps `label` at 100 characters; exceeding it fails the request.
    expect(formatDeviceLabel('h'.repeat(80), 'v'.repeat(80))).toHaveLength(100)
  })
})
