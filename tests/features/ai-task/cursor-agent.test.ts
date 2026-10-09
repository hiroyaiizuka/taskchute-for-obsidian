import { BinaryLocator, WHICH_TIMEOUT_MS } from '@/features/ai-task/services/BinaryLocator'
import type { BinaryLocatorGateway } from '@/features/ai-task/services/BinaryLocator'
import type { ExecCaptureResult } from '@/features/ai-task/services/NodeProcessGateway'
import { newestCursorVersionsFirst } from '@/features/ai-task/agents/cursor'
import { parseCursorLine } from '@/features/ai-task/services/streams/StreamJsonParser'
import { AiCustomModelStore, AI_CUSTOM_MODEL_STORAGE_KEY } from '@/features/ai-task/models/AiCustomModelStore'

// Cursor's CLI (cursor-agent), as installed and run on 2026.10.01.

const LOCAL = 'C:\\Users\\tester\\AppData\\Local'
const INSTALL = `${LOCAL}\\cursor-agent`
const ok = (stdout: string): ExecCaptureResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const miss: ExecCaptureResult = { code: 1, stdout: '', stderr: '', timedOut: false }

function windowsLocator(options: {
  where?: string
  files: string[]
  folders: Record<string, string[]>
}) {
  const execCapture = jest.fn((command: string, args: string[]) =>
    Promise.resolve(command === 'where.exe' && args[0] === 'cursor-agent' && options.where ? ok(options.where) : miss),
  )
  const gateway: BinaryLocatorGateway = {
    execCapture,
    getShellPath: () => 'C:\\Windows\\System32\\cmd.exe',
    getBaseEnv: () => ({ USERPROFILE: 'C:\\Users\\tester', LOCALAPPDATA: LOCAL }),
    getPlatform: () => 'win32',
    isFile: jest.fn((path: string) => Promise.resolve(options.files.includes(path))),
    listDirectoryNames: jest.fn((path: string) => Promise.resolve(options.folders[path] ?? [])),
    primeLoginShellPath: jest.fn(() => Promise.resolve()),
  }
  return { locator: new BinaryLocator(gateway, () => ({})), execCapture }
}

describe('Cursor on Windows', () => {
  const versions = ['2026.9.20-aaa1111', '2026.10.01-e373342', 'not-a-version']
  const newest = `${INSTALL}\\versions\\2026.10.01-e373342`

  test("runs the newest version's own node.exe with its index.js, found through the .cmd shim on PATH", async () => {
    const { locator, execCapture } = windowsLocator({
      where: `${INSTALL}\\cursor-agent.cmd\r\n`,
      files: [`${newest}\\node.exe`, `${newest}\\index.js`],
      folders: { [`${INSTALL}\\versions`]: versions },
    })

    const spec = await locator.resolve('cursor')

    expect(execCapture).toHaveBeenCalledWith('where.exe', ['cursor-agent'], WHICH_TIMEOUT_MS)
    expect(spec.executable).toBe(`${newest}\\node.exe`)
    expect(spec.argvPrefix).toEqual([`${newest}\\index.js`])
  })

  test('finds the default install folder when PATH has no shim (Obsidian started before the install)', async () => {
    const { locator } = windowsLocator({
      files: [`${newest}\\node.exe`, `${newest}\\index.js`],
      folders: { [`${INSTALL}\\versions`]: versions },
    })

    await expect(locator.resolve('cursor')).resolves.toEqual(
      expect.objectContaining({ executable: `${newest}\\node.exe`, argvPrefix: [`${newest}\\index.js`] }),
    )
  })

  test('skips a newest version that is incomplete (an update in progress)', async () => {
    const older = `${INSTALL}\\versions\\2026.9.20-aaa1111`
    const { locator } = windowsLocator({
      files: [`${newest}\\index.js`, `${older}\\node.exe`, `${older}\\index.js`],
      folders: { [`${INSTALL}\\versions`]: versions },
    })

    await expect(locator.resolve('cursor')).resolves.toEqual(
      expect.objectContaining({ executable: `${older}\\node.exe` }),
    )
  })

  test('orders version folders newest first, including the form with a build time', () => {
    expect(
      newestCursorVersionsFirst([
        '2026.9.20-aaa1111',
        '2026.10.01-bbb2222',
        '2026.10.01-08-30-00-ccc3333',
        'latest',
      ]),
    ).toEqual(['2026.10.01-08-30-00-ccc3333', '2026.10.01-bbb2222', '2026.9.20-aaa1111'])
  })
})

describe('Cursor stream-json lines', () => {
  const line = (value: Record<string, unknown>) => JSON.stringify({ ...value, session_id: 's-1' })

  test('thinking and the echo of the prompt show nothing', () => {
    expect(parseCursorLine(line({ type: 'thinking', subtype: 'delta', text: 'hmm' }))).toEqual([])
    expect(parseCursorLine(line({ type: 'user', message: { content: [{ type: 'text', text: 'p' }] } }))).toEqual([])
  })

  test('a command that exits non-zero is a failed tool result', () => {
    const completed = line({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { shellToolCall: { args: { command: 'false' }, result: { success: { exitCode: 1, stdout: '', stderr: 'boom' } } } },
    })
    expect(parseCursorLine(completed)).toEqual([{ kind: 'tool-result', text: 'boom', isError: true }])
  })

  test('a command refused in manual mode shows what was refused', () => {
    const refused = line({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { shellToolCall: { args: { command: 'rm -rf build' }, result: { rejected: { command: 'rm -rf build', reason: '' } } } },
    })
    expect(parseCursorLine(refused)).toEqual([{ kind: 'tool-result', text: 'Rejected: rm -rf build', isError: true }])
  })

  test('a tool call without success is failed; a read shows the file content', () => {
    const rejected = line({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { editToolCall: { args: {}, result: { error: { message: 'denied' } } } },
    })
    expect(parseCursorLine(rejected)).toEqual([{ kind: 'tool-result', text: 'denied', isError: true }])
    const read = line({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { readToolCall: { args: { path: 'a.txt' }, result: { success: { content: 'text' } } } },
    })
    expect(parseCursorLine(read)).toEqual([{ kind: 'tool-result', text: 'text', isError: false }])
  })

  test('an error result, plain text output, and unknown lines are kept', () => {
    expect(parseCursorLine(line({ type: 'result', subtype: 'error', is_error: true, result: 'failed' }))).toEqual([
      { kind: 'result', subtype: 'error', isError: true, text: 'failed' },
    ])
    expect(parseCursorLine('Error: Authentication required.')).toEqual([
      { kind: 'raw', text: 'Error: Authentication required.' },
    ])
    expect(parseCursorLine(line({ type: 'interaction_query' }))).toEqual([
      { kind: 'raw', text: '[unhandled] interaction_query' },
    ])
  })
})

describe('custom models saved before Cursor existed', () => {
  test('still load, and Cursor starts with none', () => {
    const store = new AiCustomModelStore({
      loadLocalStorage: (key) =>
        key === AI_CUSTOM_MODEL_STORAGE_KEY ? { claude: [{ id: 'private/x', label: 'X' }], codex: [] } : null,
      saveLocalStorage: () => undefined,
    })
    expect(store.getCustomModels('claude')).toEqual([{ id: 'private/x', label: 'X' }])
    expect(store.getCustomModels('cursor')).toEqual([])
  })
})
