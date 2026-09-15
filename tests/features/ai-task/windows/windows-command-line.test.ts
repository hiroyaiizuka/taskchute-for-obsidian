/** Round-trips quoted tokens through a reference CommandLineToArgvW parser. */
import {
  estimateAiRunLaunchSize,
} from '../../../../src/features/ai-task/services/AiRunLaunchSizeGuard'
import {
  buildWindowsCommandLine,
  quoteWindowsArgument,
  quoteWindowsProgram,
} from '../../../../src/features/ai-task/services/windows/WindowsCommandLine'

/** CommandLineToArgvW (post-2008 CRT rules) for everything after argv[0]. */
function parseWindowsArguments(commandLine: string): string[] {
  const args: string[] = []
  let index = 0
  const length = commandLine.length
  while (index < length) {
    while (index < length && (commandLine[index] === ' ' || commandLine[index] === '\t')) {
      index += 1
    }
    if (index >= length) break
    let current = ''
    let inQuotes = false
    while (index < length) {
      const character = commandLine[index]
      if (!inQuotes && (character === ' ' || character === '\t')) break
      if (character === '\\') {
        let backslashes = 0
        while (index < length && commandLine[index] === '\\') {
          backslashes += 1
          index += 1
        }
        if (commandLine[index] === '"') {
          current += '\\'.repeat(Math.floor(backslashes / 2))
          if (backslashes % 2 === 1) {
            current += '"'
            index += 1
          }
        } else {
          current += '\\'.repeat(backslashes)
        }
        continue
      }
      if (character === '"') {
        if (inQuotes && commandLine[index + 1] === '"') {
          current += '"'
          index += 2
          continue
        }
        inQuotes = !inQuotes
        index += 1
        continue
      }
      current += character
      index += 1
    }
    args.push(current)
  }
  return args
}

/** argv[0]: up to the closing quote, backslashes literal. */
function splitProgram(commandLine: string): { program: string; rest: string } {
  expect(commandLine.startsWith('"')).toBe(true)
  const end = commandLine.indexOf('"', 1)
  return { program: commandLine.slice(1, end), rest: commandLine.slice(end + 1) }
}

const TRICKY_ARGUMENTS = [
  '',
  'plain',
  'with space',
  'tab\there',
  'say "hi"',
  '"',
  '\\',
  'ends with backslash\\',
  'ends with two\\\\',
  'C:\\Program Files\\',
  'backslash before quote \\"',
  '\\\\"\\\\',
  'multi\nline\r\nprompt',
  '日本語のプロンプト 🧪',
  '--dangerously-skip-permissions',
  '- bullet that looks like a flag',
  '%PATH% & | < > ^ !',
]

describe('buildWindowsCommandLine', () => {
  test('every argument survives the CommandLineToArgvW round trip', () => {
    const commandLine = buildWindowsCommandLine(
      'C:\\Program Files\\Claude\\claude.exe',
      TRICKY_ARGUMENTS,
    )

    const { program, rest } = splitProgram(commandLine)
    expect(program).toBe('C:\\Program Files\\Claude\\claude.exe')
    expect(parseWindowsArguments(rest)).toEqual(TRICKY_ARGUMENTS)
  })

  test.each(TRICKY_ARGUMENTS)('quotes %j into a single token', (value) => {
    expect(parseWindowsArguments(quoteWindowsArgument(value))).toEqual([value])
  })

  test('quotes the program without escaping its backslashes', () => {
    expect(quoteWindowsProgram('C:\\nodejs\\node.exe')).toBe('"C:\\nodejs\\node.exe"')
  })

  test('rejects values CreateProcess cannot carry', () => {
    expect(() => quoteWindowsArgument('a\0b')).toThrow('NUL')
    expect(() => quoteWindowsProgram('C:\\bad"path.exe')).toThrow('double quote')
    expect(() => quoteWindowsProgram('')).toThrow('empty')
  })

  test('never outgrows the launch-size preflight estimate', () => {
    // ASCII without single quotes: the Windows shape sets the estimate.
    const binaryPath = 'C:\\nodejs\\node.exe'
    const binaryArgsPrefix = ['C:\\npm\\node_modules\\claude\\cli.js']
    const extraArgs = ['--model', 'say "x"\\']
    const prompt = 'Fix C:\\repo\\ and "quote" it\\\\'

    const commandLine = buildWindowsCommandLine(binaryPath, [
      ...binaryArgsPrefix,
      ...extraArgs,
      '--',
      prompt,
    ])

    expect(commandLine.length + 1024).toBe(
      estimateAiRunLaunchSize({ binaryPath, binaryArgsPrefix, extraArgs, prompt }),
    )
  })
})
