import { extractPromptSection } from '../../../src/features/ai-task/services/PromptExtractor'

describe('extractPromptSection', () => {
  test('extracts the body under "## Prompt" until end of file', () => {
    const content = [
      '# Task note',
      '',
      '## Prompt',
      'Say hello in one line.',
      'Keep it short.',
    ].join('\n')
    expect(extractPromptSection(content)).toBe(
      'Say hello in one line.\nKeep it short.',
    )
  })

  test('stops at the next level-2 heading', () => {
    const content = [
      '## Prompt',
      'Only this line.',
      '## Notes',
      'Not part of the prompt.',
    ].join('\n')
    expect(extractPromptSection(content)).toBe('Only this line.')
  })

  test('stops at the next level-1 heading', () => {
    const content = [
      '## Prompt',
      'Prompt body.',
      '# Appendix',
      'Ignored.',
    ].join('\n')
    expect(extractPromptSection(content)).toBe('Prompt body.')
  })

  test('keeps level-3 subheadings inside the body', () => {
    const content = [
      '## Prompt',
      'Intro.',
      '### Details',
      'More detail.',
      '## Next section',
    ].join('\n')
    expect(extractPromptSection(content)).toBe('Intro.\n### Details\nMore detail.')
  })

  test('matches the heading case-insensitively', () => {
    const content = ['## prompt', 'lower case heading works.'].join('\n')
    expect(extractPromptSection(content)).toBe('lower case heading works.')
  })

  test('tolerates extra whitespace and closing hashes on the heading line', () => {
    const content = ['##   Prompt  ##', 'body here'].join('\n')
    expect(extractPromptSection(content)).toBe('body here')
  })

  test('does not match a level-3 "### Prompt" heading', () => {
    const content = ['### Prompt', 'not a level-2 section'].join('\n')
    expect(extractPromptSection(content)).toBeNull()
  })

  test('returns null when there is no Prompt heading', () => {
    const content = ['# Title', 'no prompt section'].join('\n')
    expect(extractPromptSection(content)).toBeNull()
  })

  test('returns null when the Prompt section body is empty', () => {
    const content = ['## Prompt', '', '   ', '## Next'].join('\n')
    expect(extractPromptSection(content)).toBeNull()
  })

  test('handles CRLF line endings', () => {
    const content = '## Prompt\r\nline one\r\nline two\r\n## Next\r\nrest'
    expect(extractPromptSection(content)).toBe('line one\nline two')
  })

  test('uses heading metadata when provided', () => {
    const content = [
      '# Title',
      'intro',
      '## Prompt',
      'from cache path',
      '## After',
      'tail',
    ].join('\n')
    const headings = [
      { heading: 'Title', level: 1, position: { start: { line: 0 } } },
      { heading: 'Prompt', level: 2, position: { start: { line: 2 } } },
      { heading: 'After', level: 2, position: { start: { line: 4 } } },
    ]
    expect(extractPromptSection(content, headings)).toBe('from cache path')
  })

  test('heading metadata match is case-insensitive', () => {
    const content = ['## PROMPT', 'shouting'].join('\n')
    const headings = [
      { heading: 'PROMPT', level: 2, position: { start: { line: 0 } } },
    ]
    expect(extractPromptSection(content, headings)).toBe('shouting')
  })

  test('body from heading metadata continues across level-3 headings', () => {
    const content = [
      '## Prompt',
      'a',
      '### Sub',
      'b',
      '# Stop',
      'c',
    ].join('\n')
    const headings = [
      { heading: 'Prompt', level: 2, position: { start: { line: 0 } } },
      { heading: 'Sub', level: 3, position: { start: { line: 2 } } },
      { heading: 'Stop', level: 1, position: { start: { line: 4 } } },
    ]
    expect(extractPromptSection(content, headings)).toBe('a\n### Sub\nb')
  })

  test('falls back to regex scan when heading metadata has no Prompt entry', () => {
    const content = ['## Prompt', 'still found'].join('\n')
    const headings = [
      { heading: 'Other', level: 2, position: { start: { line: 10 } } },
    ]
    expect(extractPromptSection(content, headings)).toBe('still found')
  })

  test('falls back to regex scan when heading metadata is empty', () => {
    const content = ['## Prompt', 'found via regex'].join('\n')
    expect(extractPromptSection(content, [])).toBe('found via regex')
  })
})
