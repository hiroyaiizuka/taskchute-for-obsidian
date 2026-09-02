/**
 * The label is what a user reads when choosing which seat to release. A seat is
 * one machine — every vault on it shares a device id — so the label names the
 * machine and nothing else.
 */
import { formatDeviceLabel } from '../../../src/features/license'

describe('formatDeviceLabel', () => {
  test('names the machine', () => {
    expect(formatDeviceLabel('workbench')).toBe('workbench')
  })

  test('drops the .local suffix macOS reports', () => {
    expect(formatDeviceLabel('MacBook-Pro.local')).toBe('MacBook-Pro')
  })

  test('trims surrounding whitespace', () => {
    expect(formatDeviceLabel('  workbench  ')).toBe('workbench')
  })

  test.each([
    ['a missing name', undefined],
    ['a blank name', '   '],
    ['a non-string name', 42],
  ])('returns undefined for %s', (_label, host) => {
    // The API treats the label as optional, so sending nothing is valid.
    expect(formatDeviceLabel(host)).toBeUndefined()
  })

  test('truncates to the length the API accepts', () => {
    // The API caps `label` at 100 characters; exceeding it fails the request.
    expect(formatDeviceLabel('h'.repeat(140))).toHaveLength(100)
  })
})
