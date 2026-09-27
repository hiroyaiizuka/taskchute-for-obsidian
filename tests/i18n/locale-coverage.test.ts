import { en } from '@/i18n/locales/en'
import { ja } from '@/i18n/locales/ja'
import { t, type ScopedKey } from '@/i18n'

// The type system only catches keys missing from `ja`: `ja` is assigned to
// `typeof en` as an identifier, so excess-property checks never run and a key
// that exists only in `ja` slips through. Compare the leaf paths both ways.
function leafPaths(tree: unknown, prefix = ''): string[] {
  if (typeof tree !== 'object' || tree === null) return []
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafPaths(value, `${prefix}${key}.`),
  )
}

describe('locale dictionaries', () => {
  const enKeys = new Set(leafPaths(en))
  const jaKeys = new Set(leafPaths(ja))

  test('ja has every key that en has', () => {
    expect([...enKeys].filter((key) => !jaKeys.has(key))).toEqual([])
  })

  test('ja has no key that en lacks', () => {
    expect([...jaKeys].filter((key) => !enKeys.has(key))).toEqual([])
  })
})

describe('translation key types', () => {
  // These assertions are checked by `npm run typecheck`, not by Jest: if a
  // typo stops being a type error, the unused @ts-expect-error fails tsc.
  test('unknown keys are rejected at compile time', () => {
    // @ts-expect-error -- not a key in the dictionary
    expect(t('typo.key', 'fallback')).toBe('fallback')

    const scoped: ScopedKey<'taskChuteView'> = 'navigation.projects'
    // @ts-expect-error -- a root key is not valid under the taskChuteView scope
    const misrouted: ScopedKey<'taskChuteView'> = 'common.yes'
    expect([scoped, misrouted]).toHaveLength(2)
  })
})
