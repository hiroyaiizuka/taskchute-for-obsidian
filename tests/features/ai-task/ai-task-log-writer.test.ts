import { TFile } from 'obsidian'
import {
  AiTaskLogWriter,
  STDERR_TAIL_LIMIT,
  type AiTaskLogWriterDeps,
} from '../../../src/features/ai-task/services/AiTaskLogWriter'
import type { AiRunRecord, AiStreamEvent } from '../../../src/features/ai-task/types'

const DAY_MS = 24 * 60 * 60 * 1000

const START_AT = new Date(2026, 6, 12, 9, 5, 7).getTime()
const END_AT = new Date(2026, 6, 12, 9, 6, 8).getTime()

function makeRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run-1',
    taskPath: 'TaskChute/Task/My Task.md',
    taskName: 'My Task',
    host: 'claude',
    mode: 'headless',
    status: 'succeeded',
    startedAt: START_AT,
    endedAt: END_AT,
    exitCode: 0,
    events: [
      { kind: 'init', sessionId: 'sess-1', model: 'claude-sonnet-4' },
      { kind: 'assistant-text', text: 'Hello from the assistant.' },
      { kind: 'tool-use', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', text: 'ok', isError: false },
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        totalCostUsd: 0.1234,
        numTurns: 3,
      },
    ],
    ...overrides,
  }
}

interface FolderNode {
  path: string
  children: unknown[]
}

interface Harness {
  writer: AiTaskLogWriter
  deps: AiTaskLogWriterDeps
  created: Array<{ path: string; content: string }>
  modified: Array<{ path: string; content: string }>
  ensured: string[]
  trashed: string[]
  /** Registers a vault entry so collision checks see it */
  addExistingPath(path: string): void
  /** Registers a vault note with content readable via vault.read */
  setFileContent(path: string, content: string): void
  /** Registers the AI/Logs folder tree used by pruneOldLogs */
  setLogsTree(node: FolderNode): void
}

function createHarness(options: { retentionDays?: number; now?: number } = {}): Harness {
  const created: Array<{ path: string; content: string }> = []
  const modified: Array<{ path: string; content: string }> = []
  const ensured: string[] = []
  const trashed: string[] = []
  const existingPaths = new Set<string>()
  const fileContents = new Map<string, string>()
  let logsTree: FolderNode | null = null

  const deps: AiTaskLogWriterDeps = {
    app: {
      vault: {
        create: jest.fn(async (path: string, content: string) => {
          created.push({ path, content })
          existingPaths.add(path)
          fileContents.set(path, content)
          return {}
        }),
        modify: jest.fn(async (file: TFile, content: string) => {
          modified.push({ path: file.path, content })
          fileContents.set(file.path, content)
        }),
        read: jest.fn(async (file: TFile) => fileContents.get(file.path) ?? ''),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (logsTree && path === logsTree.path) return logsTree
          if (!existingPaths.has(path)) return null
          const file = new TFile()
          file.path = path
          return file
        }),
      },
      fileManager: {
        trashFile: jest.fn(async (file: TFile) => {
          trashed.push(file.path)
        }),
      },
    },
    pathManager: {
      getAiLogsPath: () => 'TaskChute/AI/Logs',
      getAiLogsMonthPath: (yearMonth: string) => `TaskChute/AI/Logs/${yearMonth}`,
      ensureFolderExists: jest.fn(async (path: string) => {
        ensured.push(path)
      }),
    },
    getRetentionDays: () => options.retentionDays ?? 30,
    now: () => options.now ?? new Date(2026, 6, 12, 12, 0, 0).getTime(),
  }

  return {
    writer: new AiTaskLogWriter(deps),
    deps,
    created,
    modified,
    ensured,
    trashed,
    addExistingPath: (path) => existingPaths.add(path),
    setFileContent: (path, content) => {
      existingPaths.add(path)
      fileContents.set(path, content)
    },
    setLogsTree: (node) => {
      logsTree = node
    },
  }
}

describe('AiTaskLogWriter.writeRunLog', () => {
  test('writes the log note under AI/Logs/YYYY-MM with a timestamped sanitized name', async () => {
    const harness = createHarness()

    const path = await harness.writer.writeRunLog(makeRecord())

    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md')
    expect(harness.created).toHaveLength(1)
    expect(harness.created[0].path).toBe(path)
  })

  test('sanitizes vault-hostile characters out of the task name', async () => {
    const harness = createHarness()

    const path = await harness.writer.writeRunLog(
      makeRecord({ taskName: 'Fix: build/deploy #3' }),
    )

    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-Fix-build-deploy-3.md')
  })

  test('lazily ensures the AI, AI/Logs, and month folders in order', async () => {
    const harness = createHarness()
    expect(harness.ensured).toEqual([])

    await harness.writer.writeRunLog(makeRecord())

    expect(harness.ensured).toEqual([
      'TaskChute/AI',
      'TaskChute/AI/Logs',
      'TaskChute/AI/Logs/2026-07',
    ])
  })

  test('appends a -2 style suffix on file name collision', async () => {
    const harness = createHarness()
    harness.addExistingPath('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md')

    const path = await harness.writer.writeRunLog(makeRecord())
    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task-2.md')

    harness.addExistingPath('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task-2.md')
    const third = await harness.writer.writeRunLog(makeRecord())
    expect(third).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task-3.md')
  })

  test('frontmatter carries task, host, status, timestamps, exit code, cost, and turns', async () => {
    const harness = createHarness()

    await harness.writer.writeRunLog(makeRecord())
    const content = harness.created[0].content

    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('task_path: "TaskChute/Task/My Task.md"')
    expect(content).toContain('task_name: "My Task"')
    expect(content).toContain('host: claude')
    expect(content).toContain('status: succeeded')
    expect(content).toContain(`started_at: "${new Date(START_AT).toISOString()}"`)
    expect(content).toContain(`ended_at: "${new Date(END_AT).toISOString()}"`)
    expect(content).toContain('exit_code: 0')
    expect(content).toContain('cost_usd: 0.1234')
    expect(content).toContain('num_turns: 3')
  })

  test('omits unavailable numeric fields instead of writing placeholders', async () => {
    const harness = createHarness()

    await harness.writer.writeRunLog(
      makeRecord({
        exitCode: null,
        endedAt: undefined,
        events: [{ kind: 'assistant-text', text: 'partial' }],
      }),
    )
    const content = harness.created[0].content

    expect(content).not.toContain('exit_code:')
    expect(content).not.toContain('ended_at:')
    expect(content).not.toContain('cost_usd:')
    expect(content).not.toContain('num_turns:')
  })

  test('transcript keeps assistant text verbatim and tool use as one-liners', async () => {
    const harness = createHarness()

    await harness.writer.writeRunLog(makeRecord())
    const content = harness.created[0].content

    expect(content).toContain('## Transcript')
    expect(content).toContain('Hello from the assistant.')
    expect(content).toContain('- [tool] Bash')
  })

  test('renders an elision marker line for omitted events', async () => {
    const harness = createHarness()
    const events: AiStreamEvent[] = [
      { kind: 'assistant-text', text: 'head' },
      { kind: 'elision', omittedCount: 42 },
      { kind: 'assistant-text', text: 'tail' },
    ]

    await harness.writer.writeRunLog(makeRecord({ events, omittedEventCount: 42 }))

    expect(harness.created[0].content).toContain('42 events omitted')
  })

  test('caps the stderr section to the last lines only', async () => {
    const harness = createHarness()
    const stderrEvents: AiStreamEvent[] = []
    for (let index = 0; index < STDERR_TAIL_LIMIT + 10; index += 1) {
      stderrEvents.push({ kind: 'stderr', text: `stderr line ${index}` })
    }

    await harness.writer.writeRunLog(makeRecord({ events: stderrEvents }))
    const content = harness.created[0].content

    expect(content).toContain('## Stderr')
    expect(content).toContain(`stderr line ${STDERR_TAIL_LIMIT + 9}`)
    expect(content).toContain('stderr line 10')
    expect(content).not.toContain('stderr line 9\n')
  })

  test('omits the stderr section when nothing was written to stderr', async () => {
    const harness = createHarness()

    await harness.writer.writeRunLog(makeRecord())

    expect(harness.created[0].content).not.toContain('## Stderr')
  })

  test('renders user follow-up text as a quoted user line in the transcript', async () => {
    const harness = createHarness()
    const events: AiStreamEvent[] = [
      { kind: 'assistant-text', text: 'first answer' },
      { kind: 'user-text', text: 'and one more thing' },
      { kind: 'assistant-text', text: 'second answer' },
    ]

    await harness.writer.writeRunLog(makeRecord({ events }))
    const content = harness.created[0].content

    expect(content).toContain('> user: and one more thing')
    const userIndex = content.indexOf('> user: and one more thing')
    expect(userIndex).toBeGreaterThan(content.indexOf('first answer'))
    expect(userIndex).toBeLessThan(content.indexOf('second answer'))
  })
})

describe('AiTaskLogWriter.upsertRunLog', () => {
  const EXISTING_NOTE = [
    '---',
    'task_path: "TaskChute/Task/My Task.md"',
    'task_name: "My Task"',
    'host: claude',
    'status: failed',
    '---',
    '',
    '## Transcript',
    '',
    'original persisted answer',
    '',
  ].join('\n')

  test('creates a new note when the record has no log note yet', async () => {
    const harness = createHarness()

    const path = await harness.writer.upsertRunLog(makeRecord())

    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md')
    expect(harness.created).toHaveLength(1)
    expect(harness.modified).toHaveLength(0)
  })

  test('appends the continuation to the existing note and refreshes the frontmatter', async () => {
    const harness = createHarness()
    const existing = 'TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md'
    harness.setFileContent(existing, EXISTING_NOTE)

    const path = await harness.writer.upsertRunLog(
      makeRecord({
        logNotePath: existing,
        // In-memory buffer where the original events were already elided —
        // the note body must NOT be rebuilt from this.
        events: [
          { kind: 'elision', omittedCount: 42 },
          { kind: 'user-text', text: 'follow-up prompt' },
          { kind: 'assistant-text', text: 'second answer' },
        ],
        omittedEventCount: 42,
      }),
      [
        { kind: 'user-text', text: 'follow-up prompt' },
        { kind: 'assistant-text', text: 'second answer' },
        { kind: 'stderr', text: 'warn: something' },
      ],
    )

    expect(path).toBe(existing)
    expect(harness.created).toHaveLength(0)
    expect(harness.modified).toHaveLength(1)
    expect(harness.modified[0].path).toBe(existing)
    const content = harness.modified[0].content
    // The already-persisted transcript survives even though it is no longer
    // in the in-memory buffer, and no elision marker is injected.
    expect(content).toContain('## Transcript')
    expect(content).toContain('original persisted answer')
    expect(content).not.toContain('events omitted')
    // The continuation is appended after the existing body, in order.
    const originalIndex = content.indexOf('original persisted answer')
    const userIndex = content.indexOf('> user: follow-up prompt')
    const answerIndex = content.indexOf('second answer')
    expect(userIndex).toBeGreaterThan(originalIndex)
    expect(answerIndex).toBeGreaterThan(userIndex)
    expect(content).toContain('warn: something')
    // The frontmatter is regenerated from the record, not duplicated.
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('status: succeeded')
    expect(content).not.toContain('status: failed')
  })

  test('refreshes only the frontmatter when there is no continuation', async () => {
    const harness = createHarness()
    const existing = 'TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md'
    harness.setFileContent(existing, EXISTING_NOTE)

    const path = await harness.writer.upsertRunLog(
      makeRecord({ logNotePath: existing }),
    )

    expect(path).toBe(existing)
    expect(harness.modified).toHaveLength(1)
    const content = harness.modified[0].content
    expect(content).toContain('status: succeeded')
    expect(content).not.toContain('status: failed')
    expect(content).toContain('original persisted answer')
  })

  test('falls back to creating a new note when the recorded path is gone', async () => {
    const harness = createHarness()

    const path = await harness.writer.upsertRunLog(
      makeRecord({ logNotePath: 'TaskChute/AI/Logs/2026-06/deleted-note.md' }),
      [{ kind: 'user-text', text: 'follow-up prompt' }],
    )

    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md')
    expect(harness.created).toHaveLength(1)
    expect(harness.modified).toHaveLength(0)
    // The recreated note is composed from the full in-memory record.
    expect(harness.created[0].content).toContain('## Transcript')
  })
})

describe('AiTaskLogWriter.pruneOldLogs', () => {
  const NOW = new Date(2026, 6, 12, 12, 0, 0).getTime()

  function makeLogFile(path: string, mtime: number, extension = 'md'): unknown {
    return { path, extension, stat: { mtime, ctime: mtime, size: 10 } }
  }

  test('trashes markdown logs older than the retention window and keeps the rest', async () => {
    const harness = createHarness({ retentionDays: 30, now: NOW })
    const oldPath = 'TaskChute/AI/Logs/2026-05/20260501-000000-old.md'
    const freshPath = 'TaskChute/AI/Logs/2026-07/20260711-000000-fresh.md'
    const oldJsonPath = 'TaskChute/AI/Logs/2026-05/rogue.json'
    harness.setLogsTree({
      path: 'TaskChute/AI/Logs',
      children: [
        {
          path: 'TaskChute/AI/Logs/2026-05',
          children: [
            makeLogFile(oldPath, NOW - 40 * DAY_MS),
            makeLogFile(oldJsonPath, NOW - 40 * DAY_MS, 'json'),
          ],
        },
        {
          path: 'TaskChute/AI/Logs/2026-07',
          children: [makeLogFile(freshPath, NOW - 1 * DAY_MS)],
        },
      ],
    })

    await harness.writer.pruneOldLogs()

    expect(harness.trashed).toEqual([oldPath])
  })

  test('skips files without a usable stat time', async () => {
    const harness = createHarness({ retentionDays: 30, now: NOW })
    harness.setLogsTree({
      path: 'TaskChute/AI/Logs',
      children: [
        { path: 'TaskChute/AI/Logs/2026-05/no-stat.md', extension: 'md' },
      ],
    })

    await harness.writer.pruneOldLogs()

    expect(harness.trashed).toEqual([])
  })

  test('does nothing when retention is disabled', async () => {
    const harness = createHarness({ retentionDays: 0, now: NOW })
    harness.setLogsTree({
      path: 'TaskChute/AI/Logs',
      children: [makeLogFile('TaskChute/AI/Logs/2026-05/ancient.md', 0)],
    })

    await harness.writer.pruneOldLogs()

    expect(harness.trashed).toEqual([])
  })

  test('does nothing when the logs folder does not exist yet', async () => {
    const harness = createHarness({ retentionDays: 30, now: NOW })

    await expect(harness.writer.pruneOldLogs()).resolves.toBeUndefined()

    expect(harness.trashed).toEqual([])
  })

  test('keeps pruning when trashing one file fails', async () => {
    const harness = createHarness({ retentionDays: 30, now: NOW })
    const first = 'TaskChute/AI/Logs/2026-05/a-old.md'
    const second = 'TaskChute/AI/Logs/2026-05/b-old.md'
    harness.setLogsTree({
      path: 'TaskChute/AI/Logs',
      children: [makeLogFile(first, NOW - 40 * DAY_MS), makeLogFile(second, NOW - 40 * DAY_MS)],
    })
    const trashFile = harness.deps.app.fileManager.trashFile as jest.Mock
    trashFile.mockImplementationOnce(async () => {
      throw new Error('locked')
    })

    await harness.writer.pruneOldLogs()

    expect(harness.trashed).toEqual([second])
  })
})

describe('AiTaskLogWriter.writeTerminalRunLog', () => {
  function makeTerminalRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
    return makeRecord({ mode: 'terminal', events: [], ...overrides })
  }

  test('uses the same AI/Logs/YYYY-MM path shape and lazy folder creation as headless notes', async () => {
    const harness = createHarness()

    const path = await harness.writer.writeTerminalRunLog(
      makeTerminalRecord(),
      'session output',
    )

    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md')
    expect(harness.ensured).toEqual([
      'TaskChute/AI',
      'TaskChute/AI/Logs',
      'TaskChute/AI/Logs/2026-07',
    ])
    expect(harness.created).toHaveLength(1)
  })

  test('composes frontmatter with mode terminal and a fenced transcript block', async () => {
    const harness = createHarness()

    await harness.writer.writeTerminalRunLog(
      makeTerminalRecord(),
      'first line\nsecond line',
    )

    const content = harness.created[0].content
    expect(content).toContain('task_path: "TaskChute/Task/My Task.md"')
    expect(content).toContain('task_name: "My Task"')
    expect(content).toContain('host: claude')
    expect(content).toContain('status: succeeded')
    expect(content).toContain('mode: terminal')
    expect(content).toContain('exit_code: 0')
    expect(content).toContain('## Transcript')
    expect(content).toContain('```text\nfirst line\nsecond line\n```')
    expect(content.endsWith('\n')).toBe(true)
  })

  test('does not stamp mode into headless note frontmatter', async () => {
    const harness = createHarness()

    await harness.writer.writeRunLog(makeRecord())

    expect(harness.created[0].content).not.toContain('mode:')
  })

  test('extends the fence when the transcript itself contains backtick fences', async () => {
    const harness = createHarness()

    await harness.writer.writeTerminalRunLog(
      makeTerminalRecord(),
      'before\n```js\ncode\n```\nafter',
    )

    const content = harness.created[0].content
    expect(content).toContain('````text\nbefore\n```js\ncode\n```\nafter\n````')
  })

  test('resolves file name collisions with the shared suffix scheme', async () => {
    const harness = createHarness()
    harness.addExistingPath('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task.md')

    const path = await harness.writer.writeTerminalRunLog(makeTerminalRecord(), 'x')

    expect(path).toBe('TaskChute/AI/Logs/2026-07/20260712-090507-My-Task-2.md')
  })

  test('writes an empty fenced block for an empty transcript', async () => {
    const harness = createHarness()

    await harness.writer.writeTerminalRunLog(makeTerminalRecord(), '')

    const content = harness.created[0].content
    expect(content).toContain('## Transcript')
    expect(content).toContain('```text\n```')
  })
})
