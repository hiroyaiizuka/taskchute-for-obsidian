import {
  findTerminalFileLinks,
  type TerminalFileLinkMatch,
} from '../../../src/features/ai-task/ui/TerminalLinkMatcher'

function targets(text: string): Array<
  Pick<TerminalFileLinkMatch, 'path' | 'line' | 'column'>
> {
  return findTerminalFileLinks(text).map(({ path, line, column }) => ({
    path,
    line,
    column,
  }))
}

describe('findTerminalFileLinks', () => {
  test.each([
    [
      'See /Users/me/project/src/index.ts for details',
      [{ path: '/Users/me/project/src/index.ts', line: undefined, column: undefined }],
    ],
    [
      '/Users/me/project/src/index.ts:42:15',
      [{ path: '/Users/me/project/src/index.ts', line: 42, column: 15 }],
    ],
    [
      'C:\\repo\\src\\index.ts:12:3',
      [{ path: 'C:\\repo\\src\\index.ts', line: 12, column: 3 }],
    ],
    [
      'D:/repo/src/index.ts:7',
      [{ path: 'D:/repo/src/index.ts', line: 7, column: undefined }],
    ],
  ])('matches absolute file references in %s', (text, expected) => {
    expect(targets(text)).toEqual(expected)
  })

  test.each([
    [
      'Changed apps/web/src/Terminal.tsx',
      [{ path: 'apps/web/src/Terminal.tsx', line: undefined, column: undefined }],
    ],
    [
      'See ./src/utils/helper.ts:9:2',
      [{ path: './src/utils/helper.ts', line: 9, column: 2 }],
    ],
    [
      'See ..\\src\\utils\\helper.ts:9',
      [{ path: '..\\src\\utils\\helper.ts', line: 9, column: undefined }],
    ],
    [
      'Open package.json',
      [{ path: 'package.json', line: undefined, column: undefined }],
    ],
    [
      'Open docs/日本語.md',
      [{ path: 'docs/日本語.md', line: undefined, column: undefined }],
    ],
  ])('matches extension-bearing relative references in %s', (text, expected) => {
    expect(targets(text)).toEqual(expected)
  })

  test.each([
    [
      'Read(src/index.ts)',
      [{ path: 'src/index.ts', line: undefined, column: undefined }],
    ],
    [
      'Edit("docs/AI 長文テスト.md:18:4")',
      [{ path: 'docs/AI 長文テスト.md', line: 18, column: 4 }],
    ],
    [
      'Edit("docs/AI 長文テスト.md":18:4)',
      [{ path: 'docs/AI 長文テスト.md', line: 18, column: 4 }],
    ],
    [
      'Write(  01_Notes/日本語 ファイル.md  )',
      [{ path: '01_Notes/日本語 ファイル.md', line: undefined, column: undefined }],
    ],
    [
      'Update(package.json)',
      [{ path: 'package.json', line: undefined, column: undefined }],
    ],
    [
      'Create(src/new.ts) Delete(src/old.ts)',
      [
        { path: 'src/new.ts', line: undefined, column: undefined },
        { path: 'src/old.ts', line: undefined, column: undefined },
      ],
    ],
    [
      'Rename(src/old.ts) Move(src/a.ts) Copy(src/b.ts)',
      [
        { path: 'src/old.ts', line: undefined, column: undefined },
        { path: 'src/a.ts', line: undefined, column: undefined },
        { path: 'src/b.ts', line: undefined, column: undefined },
      ],
    ],
  ])('matches tool-action references in %s', (text, expected) => {
    expect(targets(text)).toEqual(expected)
  })

  test('matches quoted paths with spaces and keeps the range inside the quotes', () => {
    const text = 'Open "01_Notes/会議 メモ.md:20:6" now'

    const [match] = findTerminalFileLinks(text)

    expect(match).toMatchObject({
      path: '01_Notes/会議 メモ.md',
      line: 20,
      column: 6,
      fullMatch: '01_Notes/会議 メモ.md:20:6',
    })
    expect(text.slice(match.startIndex, match.endIndex)).toBe(match.fullMatch)
  })

  test('reads a line and column suffix placed after a quoted path', () => {
    const text = 'Open "docs/AI 長文テスト.md":31:7 now'

    const [match] = findTerminalFileLinks(text)

    expect(match).toMatchObject({
      path: 'docs/AI 長文テスト.md',
      line: 31,
      column: 7,
    })
    expect(text.slice(match.startIndex, match.endIndex)).toBe(match.fullMatch)
  })

  test('does not include square brackets surrounding a file reference', () => {
    const text = 'Changed [src/features/example.ts]'

    const [match] = findTerminalFileLinks(text)

    expect(match.path).toBe('src/features/example.ts')
    expect(match.fullMatch).toBe('src/features/example.ts')
    expect(text.slice(match.startIndex, match.endIndex)).toBe(match.fullMatch)
  })

  test('decodes file:// paths and preserves the displayed URI as the link range', () => {
    const text =
      'Open "file:///Users/me/My%20Project/%E6%97%A5%E6%9C%AC%E8%AA%9E.md:9:4"'

    const [match] = findTerminalFileLinks(text)

    expect(match).toMatchObject({
      path: '/Users/me/My Project/日本語.md',
      line: 9,
      column: 4,
      fullMatch:
        'file:///Users/me/My%20Project/%E6%97%A5%E6%9C%AC%E8%AA%9E.md:9:4',
    })
    expect(text.slice(match.startIndex, match.endIndex)).toBe(match.fullMatch)
  })

  test('matches an unquoted file:// URI', () => {
    expect(targets('file:///Users/me/project/src/index.ts:4')).toEqual([
      {
        path: '/Users/me/project/src/index.ts',
        line: 4,
        column: undefined,
      },
    ])
  })

  test.each([
    'http://localhost:3000/api/src/file.ts',
    'https://example.com/path/to/page.ts:12',
    'ftp://server/path/file.txt',
  ])('never treats a URL or a path nested inside it as a file: %s', (text) => {
    expect(findTerminalFileLinks(text)).toEqual([])
  })

  test('does not emit overlapping relative matches inside a tool action', () => {
    const text = 'Write(src/features/example.ts)'

    const matches = findTerminalFileLinks(text)

    expect(matches).toHaveLength(1)
    expect(matches[0].path).toBe('src/features/example.ts')
    expect(matches[0].startIndex).toBe('Write('.length)
    expect(matches[0].endIndex).toBe('Write(src/features/example.ts'.length)
  })

  test.each([
    'plain prose without a path',
    'node_modules/express',
    'https://example.com/package.json',
    'version 1.2.3',
    'contact foo@example.com',
    'visit example.com',
    'Use Node.js for this task',
  ])('avoids common non-file text: %s', (text) => {
    expect(findTerminalFileLinks(text)).toEqual([])
  })
})
