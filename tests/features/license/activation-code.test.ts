import {
  formatActivationCode,
  normalizeCode,
} from '../../../src/features/license/token/code'

const CANONICAL = '8F3K2M9QX7RD4WPZ'

describe('normalizeCode', () => {
  test.each([
    ['the canonical form', '8F3K2M9QX7RD4WPZ'],
    ['a prefixed, hyphenated code', 'TCP-8F3K-2M9Q-X7RD-4WPZ'],
    ['surrounding whitespace', '  TCP-8F3K-2M9Q-X7RD-4WPZ  '],
    ['lowercase', 'tcp-8f3k-2m9q-x7rd-4wpz'],
    ['no hyphens', 'TCP8F3K2M9QX7RD4WPZ'],
  ])('accepts %s', (_label, input) => {
    expect(normalizeCode(input)).toBe(CANONICAL)
  })

  test('maps the Crockford lookalikes I, L and O', () => {
    expect(normalizeCode('IL0000000000000O')).toBe('1100000000000000')
  })

  test('does not strip a TCP that is part of the body', () => {
    // Decided by length, so a 16-char body beginning with TCP survives intact.
    expect(normalizeCode('TCP0000000000000')).toBe('TCP0000000000000')
  })

  test.each([
    ['an empty string', ''],
    ['a short code', 'TCP-8F3K'],
    ['a long code', `${CANONICAL}0`],
    ['the excluded letter U', '8F3K2M9QX7RD4WPU'],
    ['punctuation', '8F3K2M9QX7RD4WP!'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeCode(input)).toBeNull()
  })
})

describe('formatActivationCode', () => {
  test('groups the body in fours behind the prefix', () => {
    expect(formatActivationCode(CANONICAL)).toBe('TCP-8F3K-2M9Q-X7RD-4WPZ')
  })

  test('round-trips through normalizeCode', () => {
    expect(normalizeCode(formatActivationCode(CANONICAL))).toBe(CANONICAL)
  })
})
