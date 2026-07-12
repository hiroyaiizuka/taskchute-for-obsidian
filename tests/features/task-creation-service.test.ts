import { Notice, TFile } from 'obsidian'
import { TaskCreationService } from '../../src/features/core/services/TaskCreationService'
import { readAiTaskConfig } from '../../src/features/ai-task/services/AiTaskFrontmatterReader'
import { extractPromptSection } from '../../src/features/ai-task/services/PromptExtractor'
import type { TaskChutePluginLike } from '../../src/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

describe('TaskCreationService', () => {
  const createPlugin = () => {
    const file = new TFile()
    file.path = 'TaskChute/Task/My Task.md'
    file.basename = 'My Task'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create: jest.fn().mockResolvedValue(file),
        },
      },
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as TaskChutePluginLike & { app: { vault: { getAbstractFileByPath: jest.Mock; create: jest.Mock } } }

    return plugin
  }

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
  })

  test('createTaskFile writes taskId into frontmatter', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '08:30')

    expect(plugin.app.vault.create).toHaveBeenCalledTimes(1)
    const content = plugin.app.vault.create.mock.calls[0]?.[1] as string
    expect(content).toContain('taskId: "tc-task-')
    expect(content).toContain('target_date: "2025-11-16"')
    expect(content).toContain('scheduled_time: "08:30"')
  })

  test('createTaskFile uses provided taskId when supplied', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', undefined, {
      taskId: 'tc-task-restore',
    })

    const lastCall = plugin.app.vault.create.mock.calls[plugin.app.vault.create.mock.calls.length - 1]
    const content = lastCall?.[1] as string
    expect(content).toContain('taskId: "tc-task-restore"')
  })

  test('createTaskFile writes reminder_time when supplied', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '09:00', {
      reminderTime: '08:55',
    })

    const lastCall = plugin.app.vault.create.mock.calls[plugin.app.vault.create.mock.calls.length - 1]
    const content = lastCall?.[1] as string
    expect(content).toContain('scheduled_time: "09:00"')
    expect(content).toContain('reminder_time: "08:55"')
  })

  test('createTaskFile emits NO ai fields without the aiTask option', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '08:30')

    const content = plugin.app.vault.create.mock.calls[0]?.[1] as string
    expect(content).not.toContain('ai_task')
    expect(content).not.toContain('## Prompt')
  })
})

/**
 * Minimal parser for the frontmatter block this service emits (scalars,
 * booleans, and block lists of double-quoted strings). The emitted format is
 * fully controlled by createTaskFile, so this subset is exact.
 */
function parseEmittedFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error('content has no frontmatter block')
  const result: Record<string, unknown> = {}
  let currentListKey: string | null = null
  for (const line of match[1].split('\n')) {
    const item = line.match(/^ {2}- (.*)$/)
    if (item && currentListKey !== null) {
      ;(result[currentListKey] as unknown[]).push(parseEmittedScalar(item[1]))
      continue
    }
    const kv = line.match(/^([A-Za-z_]+):(.*)$/)
    if (!kv) continue
    const rest = kv[2].trim()
    if (rest === '') {
      result[kv[1]] = []
      currentListKey = kv[1]
      continue
    }
    currentListKey = null
    result[kv[1]] = parseEmittedScalar(rest)
  }
  return result
}

function parseEmittedScalar(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return raw
}

describe('TaskCreationService AI task notes (U3)', () => {
  const createPlugin = () => {
    const file = new TFile()
    file.path = 'TaskChute/Task/AI Task.md'
    file.basename = 'AI Task'
    file.extension = 'md'

    return {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create: jest.fn().mockResolvedValue(file),
        },
      },
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as TaskChutePluginLike & {
      app: { vault: { getAbstractFileByPath: jest.Mock; create: jest.Mock } }
    }
  }

  async function createdContent(
    options: Parameters<TaskCreationService['createTaskFile']>[3],
    scheduledTime?: string,
  ): Promise<string> {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)
    await service.createTaskFile('AI Task', '2025-11-16', scheduledTime, options)
    return plugin.app.vault.create.mock.calls[0]?.[1] as string
  }

  test('round-trips host, args, cwd, and prompt through the real reader and extractor', async () => {
    const content = await createdContent({
      aiTask: {
        host: 'codex',
        args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--model=o3'],
        cwd: '/Users/me/project',
        prompt: 'Review the PR\nThen summarize the findings',
      },
    })

    const frontmatter = parseEmittedFrontmatter(content)
    expect(frontmatter['ai_task']).toBe(true)

    const config = readAiTaskConfig(frontmatter)
    expect(config).toEqual({
      host: 'codex',
      args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--model=o3'],
      cwd: '/Users/me/project',
    })

    expect(extractPromptSection(content)).toBe(
      'Review the PR\nThen summarize the findings',
    )
  })

  test('omits args and cwd keys when empty and keeps host claude', async () => {
    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt: 'Say hello' },
    })

    expect(content).not.toContain('ai_task_args')
    expect(content).not.toContain('ai_task_cwd')

    const config = readAiTaskConfig(parseEmittedFrontmatter(content))
    expect(config).toEqual({ host: 'claude', args: [], cwd: undefined })
    expect(extractPromptSection(content)).toBe('Say hello')
  })

  test('writes an empty "## Prompt" section for an empty prompt', async () => {
    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt: '' },
    })

    expect(content).toContain('\n## Prompt\n')
    // An empty section extracts as null — the terminal run mode treats that
    // as a plain REPL start.
    expect(extractPromptSection(content)).toBeNull()
    expect(readAiTaskConfig(parseEmittedFrontmatter(content))).not.toBeNull()
  })

  test('keeps the standard fields (target_date, taskId, scheduled_time, heading) intact', async () => {
    const content = await createdContent(
      { aiTask: { host: 'claude', args: ['--max-turns', '1'], prompt: 'Go' } },
      '09:30',
    )

    expect(content).toContain('target_date: "2025-11-16"')
    expect(content).toContain('taskId: "tc-task-')
    expect(content).toContain('scheduled_time: "09:30"')
    expect(content).toContain('\n# AI Task\n')
    // The prompt section sits AFTER the H1 heading.
    expect(content.indexOf('## Prompt')).toBeGreaterThan(content.indexOf('# AI Task'))
  })
})
