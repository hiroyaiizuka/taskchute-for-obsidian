import {
  modelFamily,
  modelLine,
  newestPerLine,
  onePerFamily,
  withoutVariantWords,
} from '@/features/ai-task/models/modelLines'

const id = (value: string) => value

describe('modelLines', () => {
  test('reads the model an ID names, without its variant words', () => {
    expect(modelFamily('claude-opus-5-5-high-fast')).toBe('claude-opus-5-5')
    expect(modelFamily('claude-sonnet-5-thinking-xhigh')).toBe('claude-sonnet-5')
    expect(modelFamily('gpt-5.3-codex')).toBe('gpt-5.3-codex')
  })

  test('splits an ID into its line and version, whatever the word order', () => {
    expect(modelLine('claude-opus-5-5-medium')).toEqual({ line: 'claude opus', version: [5, 5] })
    expect(modelLine('claude-4.6-opus')).toEqual({ line: 'claude opus', version: [4, 6] })
    // Cursor's own builds are the same line as the vendor's.
    expect(modelLine('cursor-grok-4.6-high').line).toBe(modelLine('grok-4.7-medium').line)
  })

  test('keeps only the newest version of each line, in list order', () => {
    expect(
      newestPerLine(['gpt-5.6-sol', 'claude-opus-5', 'gpt-5.5-sol', 'claude-opus-5-5', 'gpt-5.6-luna'], id),
    ).toEqual(['gpt-5.6-sol', 'claude-opus-5-5', 'gpt-5.6-luna'])
  })

  test('picks one ID per model: plain, else medium, else not fast', () => {
    expect(onePerFamily(['gpt-5.3-codex-low', 'gpt-5.3-codex', 'gpt-5.3-codex-high'], id)).toEqual([
      'gpt-5.3-codex',
    ])
    expect(onePerFamily(['opus-5-5-low', 'opus-5-5-medium-fast', 'opus-5-5-medium'], id)).toEqual([
      'opus-5-5-medium',
    ])
    expect(onePerFamily(['grok-4.5-high-fast', 'grok-4.5-high'], id)).toEqual(['grok-4.5-high'])
    expect(onePerFamily(['only-fast'], id)).toEqual(['only-fast'])
  })

  test('drops variant words from the end of a name, keeping a bracketed note', () => {
    expect(withoutVariantWords('Claude Opus 5.5 1M Extra High Fast')).toBe('Claude Opus 5.5')
    expect(withoutVariantWords('Grok 4.7  Medium')).toBe('Grok 4.7')
    expect(withoutVariantWords('Claude Fable 5.1 1M Medium (NO ZDR)')).toBe('Claude Fable 5.1 (NO ZDR)')
    expect(withoutVariantWords('Composer 2.5')).toBe('Composer 2.5')
  })
})
