import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { parse as parseYaml } from 'yaml'
import {
  AiTaskEditService,
  AiTaskPromptMarkersError,
} from '../../../src/features/ai-task/services/AiTaskEditService'
import {
  EXACT_PROMPT_END_MARKER,
  EXACT_PROMPT_START_MARKER,
  extractPromptSection,
} from '../../../src/features/ai-task/services/PromptExtractor'

function makeFile(path = 'TaskChute/Task/AI Review.md'): TFile {
  const file = new TFile()
  file.path = path
  file.basename = 'AI Review'
  file.extension = 'md'
  return file
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content)
  if (!match) throw new Error('Missing frontmatter')
  return parseYaml(match[1]) as Record<string, unknown>
}

function createHarness(initial: string, cachedReadError?: Error) {
  let content = initial
  const file = makeFile()
  const cachedRead = cachedReadError
    ? jest.fn().mockRejectedValue(cachedReadError)
    : jest.fn(async () => content)
  const read = jest.fn(async () => content)
  const modify = jest.fn(async (_file: TFile, updated: string) => {
    content = updated
  })
  const app = {
    vault: { cachedRead, read, modify },
  } as unknown as App

  return {
    file,
    service: new AiTaskEditService(app),
    cachedRead,
    read,
    modify,
    getContent: () => content,
  }
}

describe('AiTaskEditService', () => {
  describe('load', () => {
    test('loads normalized AI config, prompt, schedule, file, and display name', async () => {
      const content = [
        '---',
        'ai_task: true',
        'ai_task_host: codex',
        'ai_task_args:',
        '  - "--model=gpt-5.6-sol"',
        '  - "--config"',
        '  - "model_reasoning_effort=\\"max\\""',
        'ai_task_cwd: "/Users/demo/My Project"',
        'scheduled_time: "08:00"',
        '---',
        '# AI Review',
        '## Prompt',
        EXACT_PROMPT_START_MARKER,
        'Review this week.',
        EXACT_PROMPT_END_MARKER,
      ].join('\n')
      const harness = createHarness(content)
      const frontmatter = parseFrontmatter(content)

      await expect(
        harness.service.load(harness.file, frontmatter, 'AI CEO Review'),
      ).resolves.toEqual({
        file: harness.file,
        taskName: 'AI CEO Review',
        host: 'codex',
        args: [
          '--model=gpt-5.6-sol',
          '--config',
          'model_reasoning_effort="max"',
        ],
        cwd: '/Users/demo/My Project',
        prompt: 'Review this week.',
        scheduledTime: '08:00',
      })
      expect(harness.cachedRead).toHaveBeenCalledWith(harness.file)
      expect(harness.read).not.toHaveBeenCalled()
    })

    test('returns null without reading a non-AI task', async () => {
      const harness = createHarness('# Human task')

      await expect(
        harness.service.load(harness.file, { ai_task: false }, 'Human task'),
      ).resolves.toBeNull()
      expect(harness.cachedRead).not.toHaveBeenCalled()
      expect(harness.read).not.toHaveBeenCalled()
    })

    test('falls back to an uncached read when cachedRead fails', async () => {
      const content = [
        '---',
        'ai_task: true',
        '---',
        '## Prompt',
        'fallback content',
      ].join('\n')
      const harness = createHarness(content, new Error('stale cache'))

      const value = await harness.service.load(
        harness.file,
        { ai_task: true, '開始時刻': '09:30' },
        'Fallback',
      )

      expect(value).toMatchObject({
        host: 'claude',
        args: [],
        prompt: 'fallback content',
        scheduledTime: '09:30',
      })
      expect(harness.read).toHaveBeenCalledWith(harness.file)
    })
  })

  describe('save', () => {
    test('updates only managed frontmatter and marked prompt while preserving task metadata and custom Markdown', async () => {
      const customBody = [
        '## Notes',
        'Do not rewrite this paragraph.',
        '### Custom subsection',
        '- [ ] untouched',
      ].join('\n')
      const initial = [
        '---',
        'target_date: "2026-07-16"',
        'taskId: "task-keep-me"',
        'tags:',
        '  - task',
        '  - custom-tag',
        'routine:',
        '  enabled: true',
        '  frequency: weekly',
        'obsidian_sync: true',
        'obsidian_sync_task_name: "CEO Review"',
        'reminder_time: "07:55"',
        'custom_field:',
        '  nested: keep',
        'ai_task: true',
        'ai_task_host: claude',
        'ai_task_args: "--model old --effort low"',
        'ai_task_cwd: "/old/path"',
        'scheduled_time: "07:00"',
        '---',
        '',
        '# AI Review',
        '',
        '## Prompt',
        '',
        EXACT_PROMPT_START_MARKER,
        'old prompt',
        EXACT_PROMPT_END_MARKER,
        '',
        customBody,
        '',
      ].join('\n')
      const harness = createHarness(initial)

      await harness.service.save(harness.file, '08:30', {
        host: 'codex',
        args: ['--model=gpt-5.6-sol', '--config', 'model_reasoning_effort="max"'],
        cwd: '/new/project',
        prompt: 'new prompt\nwith details',
      })

      const updated = harness.getContent()
      const frontmatter = parseFrontmatter(updated)
      expect(frontmatter).toMatchObject({
        target_date: '2026-07-16',
        taskId: 'task-keep-me',
        tags: ['task', 'custom-tag'],
        routine: { enabled: true, frequency: 'weekly' },
        obsidian_sync: true,
        obsidian_sync_task_name: 'CEO Review',
        reminder_time: '07:55',
        custom_field: { nested: 'keep' },
        ai_task: true,
        ai_task_host: 'codex',
        ai_task_args: [
          '--model=gpt-5.6-sol',
          '--config',
          'model_reasoning_effort="max"',
        ],
        ai_task_cwd: '/new/project',
        scheduled_time: '08:30',
      })
      expect(extractPromptSection(updated)).toBe('new prompt\nwith details')
      expect(updated).toContain(`${EXACT_PROMPT_END_MARKER}\n\n${customBody}\n`)
      expect(harness.modify).toHaveBeenCalledTimes(1)
      expect(harness.modify).toHaveBeenCalledWith(harness.file, updated)
    })

    test('safely round-trips raw and pre-escaped hash-leading prompt lines', async () => {
      const initial = [
        '---',
        'ai_task: true',
        'ai_task_host: claude',
        '---',
        '## Prompt',
        EXACT_PROMPT_START_MARKER,
        'old',
        EXACT_PROMPT_END_MARKER,
      ].join('\n')
      const harness = createHarness(initial)
      const prompt = '# Overview\n  ## Steps\n\\# literal\n    # code comment'

      await harness.service.save(harness.file, undefined, {
        host: 'claude',
        args: ['--effort=max'],
        prompt,
      })

      const updated = harness.getContent()
      expect(updated).toContain('\\# Overview\n  \\## Steps\n\\\\# literal\n    # code comment')
      expect(extractPromptSection(updated)).toBe(prompt)
    })

    test('clears optional cwd and both canonical and legacy scheduled time fields', async () => {
      const initial = [
        '---',
        'taskId: keep',
        'scheduled_time: "08:00"',
        '開始時刻: "09:00"',
        'ai_task: true',
        'ai_task_host: codex',
        'ai_task_args:',
        '',
        '  - "--old"',
        'ai_task_cwd: "/old"',
        '---',
        '## Prompt',
        EXACT_PROMPT_START_MARKER,
        'old',
        EXACT_PROMPT_END_MARKER,
      ].join('\n')
      const harness = createHarness(initial)

      await harness.service.save(harness.file, undefined, {
        host: 'claude',
        args: [],
        cwd: '   ',
        prompt: '',
      })

      expect(parseFrontmatter(harness.getContent())).toEqual({
        taskId: 'keep',
        ai_task: true,
        ai_task_host: 'claude',
      })
      expect(extractPromptSection(harness.getContent())).toBeNull()
    })

    test('adds markers to a legacy Prompt section without deleting its unknown body', async () => {
      const initial = [
        '---',
        'taskId: keep',
        'ai_task: true',
        '---',
        '# Legacy AI task',
        '## Prompt',
        'legacy text must remain',
        '## Notes',
        'also remain',
      ].join('\n')
      const harness = createHarness(initial)

      await harness.service.save(harness.file, '10:00', {
        host: 'codex',
        prompt: 'edited prompt',
      })

      const updated = harness.getContent()
      expect(extractPromptSection(updated)).toBe('edited prompt')
      expect(updated).toContain(
        `${EXACT_PROMPT_END_MARKER}\nlegacy text must remain\n## Notes\nalso remain`,
      )
    })

    test('rejects incomplete markers without modifying the file', async () => {
      const initial = [
        '---',
        'ai_task: true',
        '---',
        '## Prompt',
        EXACT_PROMPT_START_MARKER,
        'unterminated',
      ].join('\n')
      const harness = createHarness(initial)

      await expect(
        harness.service.save(harness.file, undefined, {
          host: 'claude',
          prompt: 'replacement',
        }),
      ).rejects.toBeInstanceOf(AiTaskPromptMarkersError)
      expect(harness.modify).not.toHaveBeenCalled()
      expect(harness.getContent()).toBe(initial)
    })
  })
})
