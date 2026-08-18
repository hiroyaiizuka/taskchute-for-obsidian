import {
  EXACT_PROMPT_END_MARKER,
  EXACT_PROMPT_START_MARKER,
  extractPromptSection,
} from '../../../src/features/ai-task/services/PromptExtractor'

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

  test('keeps the legacy trim behavior when exact markers are absent', () => {
    const content = ['## Prompt', '', '  legacy body  ', ''].join('\n')
    expect(extractPromptSection(content)).toBe('legacy body')
  })

  test('preserves outer whitespace exactly between generated markers', () => {
    const prompt = '\n    indented first line  \nlast line  \n'
    const content = [
      '## Prompt',
      '',
      EXACT_PROMPT_START_MARKER,
      ...prompt.split('\n'),
      EXACT_PROMPT_END_MARKER,
      '## Next',
    ].join('\n')

    expect(extractPromptSection(content)).toBe(prompt)
  })

  test('treats marked whitespace-only content as an empty prompt', () => {
    const content = [
      '## Prompt',
      EXACT_PROMPT_START_MARKER,
      '  ',
      '\t',
      EXACT_PROMPT_END_MARKER,
    ].join('\n')

    expect(extractPromptSection(content)).toBeNull()
  })

  test('preserves exact marked whitespace on the heading-metadata path', () => {
    const prompt = '\tfirst\nlast  '
    const content = [
      '# Task',
      '## Prompt',
      EXACT_PROMPT_START_MARKER,
      ...prompt.split('\n'),
      EXACT_PROMPT_END_MARKER,
      '## Next',
    ].join('\n')
    const headings = [
      { heading: 'Task', level: 1, position: { start: { line: 0 } } },
      { heading: 'Prompt', level: 2, position: { start: { line: 1 } } },
      { heading: 'Next', level: 2, position: { start: { line: 6 } } },
    ]

    expect(extractPromptSection(content, headings)).toBe(prompt)
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

  describe('backslash-escaped hash lines (write-time escaping counterpart)', () => {
    test('unescapes escaped H1/H2 lines back to the entered prompt text', () => {
      // TaskCreationService escapes hash-leading prompt lines so they do not
      // terminate the section; extraction reverses that escaping.
      const content = [
        '## Prompt',
        'Intro line.',
        '\\# Overview',
        'Details.',
        '\\## Steps',
        'Done.',
      ].join('\n')
      expect(extractPromptSection(content)).toBe(
        'Intro line.\n# Overview\nDetails.\n## Steps\nDone.',
      )
    })

    test('strips exactly one backslash so pre-escaped lines survive the round trip', () => {
      // A prompt line entered as "\# literal" is written as "\\# literal".
      const content = ['## Prompt', '\\\\# literal'].join('\n')
      expect(extractPromptSection(content)).toBe('\\# literal')
    })

    test('unescapes hash-leading lines that are not headings (tags)', () => {
      const content = ['## Prompt', '\\#tag mention', 'tail'].join('\n')
      expect(extractPromptSection(content)).toBe('#tag mention\ntail')
    })

    test('leaves backslashes elsewhere in the line untouched', () => {
      const content = ['## Prompt', 'path C:\\temp and \\# not at line start? no: mid-line'].join(
        '\n',
      )
      expect(extractPromptSection(content)).toBe(
        'path C:\\temp and \\# not at line start? no: mid-line',
      )
    })

    test('unescapes on the heading-metadata path too', () => {
      const content = ['## Prompt', '\\# Overview', 'body'].join('\n')
      const headings = [
        { heading: 'Prompt', level: 2, position: { start: { line: 0 } } },
      ]
      expect(extractPromptSection(content, headings)).toBe('# Overview\nbody')
    })
  })

  describe('indented (1-3 space) hash lines — CommonMark heading indentation', () => {
    // Carried WARNING regression: CommonMark (and Obsidian's heading cache)
    // recognizes ATX headings indented by up to three spaces, so the stop
    // condition and the escape pair must cover them too.
    test('stops at an indented H2 heading in the regex fallback', () => {
      const content = ['## Prompt', 'body line', '  ## Next section', 'after'].join('\n')
      expect(extractPromptSection(content)).toBe('body line')
    })

    test('stops at an indented H1 heading in the regex fallback', () => {
      const content = ['## Prompt', 'body line', '   # Top', 'after'].join('\n')
      expect(extractPromptSection(content)).toBe('body line')
    })

    test('unescapes escaped hash lines behind 1-3 spaces of indentation', () => {
      const content = [
        '## Prompt',
        'intro',
        '  \\# indented item',
        '   \\\\## keep one backslash',
      ].join('\n')
      expect(extractPromptSection(content)).toBe(
        'intro\n  # indented item\n   \\## keep one backslash',
      )
    })

    test('leaves 4-space-indented hash lines untouched (indented code, not a heading)', () => {
      const content = [
        '## Prompt',
        'code:',
        '    # code comment',
        '    \\# escaped inside code',
        'after',
      ].join('\n')
      expect(extractPromptSection(content)).toBe(
        'code:\n    # code comment\n    \\# escaped inside code\nafter',
      )
    })
  })
})
