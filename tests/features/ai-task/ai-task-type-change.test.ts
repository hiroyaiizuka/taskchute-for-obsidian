import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { AiTaskEditService } from '@/features/ai-task/services/AiTaskEditService'
import { EXACT_PROMPT_END_MARKER, EXACT_PROMPT_START_MARKER } from '@/features/ai-task/services/PromptExtractor'
import {
  getSharedAiTaskAmbientScheduleStateStore,
} from '@/features/ai-task/services/AiTaskAmbientScheduleStateStore'

function harness(initial: string) {
  let content = initial
  const file = new TFile()
  file.path = 'TaskChute/Task/Daily report.md'
  const app = {
    vault: {
      cachedRead: jest.fn(async () => content),
      read: jest.fn(async () => content),
      modify: jest.fn(async (_file: TFile, updated: string) => {
        content = updated
      }),
    },
  } as unknown as App
  return { file, app, service: new AiTaskEditService(app), get: () => content }
}

const aiNote = (newline = '\n') => [
  '---',
  'tags:',
  '  - task',
  'isRoutine: true',
  'routine_type: daily',
  'ai_task: true',
  'ai_task_host: codex',
  'ai_task_args:',
  '  - "--model"',
  '  - "gpt-5"',
  'ai_task_cwd: "/work/repo"',
  'obsidian_sync:',
  '  enabled: true',
  '  taskTitle: "Write report"',
  '  matchType: exact',
  'scheduled_time: "09:00"',
  'taskId: tc-task-1',
  '---',
  '',
  'Notes written by hand.',
  '',
  '## Prompt',
  '',
  EXACT_PROMPT_START_MARKER,
  'Summarise yesterday.',
  EXACT_PROMPT_END_MARKER,
  '',
].join(newline)

describe('AiTaskEditService.convertToHuman', () => {
  test('removes only the AI keys and keeps the schedule, routine, id and body', async () => {
    const h = harness(aiNote())
    await h.service.convertToHuman(h.file)
    expect(h.get()).toBe([
      '---',
      'tags:',
      '  - task',
      'isRoutine: true',
      'routine_type: daily',
      'scheduled_time: "09:00"',
      'taskId: tc-task-1',
      '---',
      '',
      'Notes written by hand.',
      '',
      '## Prompt',
      '',
      EXACT_PROMPT_START_MARKER,
      'Summarise yesterday.',
      EXACT_PROMPT_END_MARKER,
      '',
    ].join('\n'))
  })

  test('keeps CRLF line endings', async () => {
    const h = harness(aiNote('\r\n'))
    await h.service.convertToHuman(h.file)
    expect(h.get()).toContain('\r\n')
    expect(h.get()).not.toMatch(/ai_task|obsidian_sync/)
    expect(h.get().split('\r\n').every((line) => !line.includes('\n'))).toBe(true)
  })

  test('keeps a legacy 開始時刻 start time', async () => {
    const h = harness(['---', 'ai_task: true', 'ai_task_host: claude', '開始時刻: "07:30"', '---', 'body'].join('\n'))
    await h.service.convertToHuman(h.file)
    expect(h.get()).toBe(['---', '開始時刻: "07:30"', '---', 'body'].join('\n'))
  })

  test('leaves a note without frontmatter, or without AI keys, untouched', async () => {
    for (const content of ['just text', ['---', 'tags: [task]', '---', 'x'].join('\n')]) {
      const h = harness(content)
      await h.service.convertToHuman(h.file)
      expect(h.get()).toBe(content)
      expect((h.app.vault.modify as jest.Mock)).not.toHaveBeenCalled()
    }
  })

  test('switching back to AI reuses the Prompt section left in the body', async () => {
    const h = harness(aiNote())
    await h.service.convertToHuman(h.file)
    const value = await h.service.loadForTypeChange(h.file, { scheduled_time: '09:00' }, 'Daily report')
    expect(value.prompt).toBe('Summarise yesterday.')
    expect(value.scheduledTime).toBe('09:00')
    expect(value.host).toBe('claude')
    await h.service.save(h.file, value.scheduledTime, { host: 'claude', args: [], prompt: value.prompt })
    const after = h.get()
    expect(after).toContain('ai_task: true')
    expect(after.split(EXACT_PROMPT_START_MARKER)).toHaveLength(2)
  })
})

describe('AiTaskEditService.loadForTypeChange', () => {
  test('loads an AI task with its own settings', async () => {
    const h = harness(aiNote())
    const value = await h.service.loadForTypeChange(
      h.file,
      { ai_task: true, ai_task_host: 'codex', ai_task_args: ['--model', 'gpt-5'], ai_task_cwd: '/work/repo', scheduled_time: '09:00' },
      'Daily report',
    )
    expect(value.host).toBe('codex')
    expect(value.cwd).toBe('/work/repo')
    expect(value.prompt).toBe('Summarise yesterday.')
  })

  test('gives a human task the defaults and an empty prompt', async () => {
    const h = harness(['---', 'tags: [task]', '---', 'body'].join('\n'))
    const value = await h.service.loadForTypeChange(h.file, { tags: ['task'] }, 'Write report')
    expect(value).toMatchObject({ host: 'claude', args: [], prompt: '', taskName: 'Write report' })
  })
})

describe('getSharedAiTaskAmbientScheduleStateStore', () => {
  test('hands every caller the same store for one app, so a mark is seen by the scheduler', () => {
    const storage = new Map<string, unknown>()
    const app = {
      loadLocalStorage: (key: string) => storage.get(key),
      saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
    }
    const scheduler = getSharedAiTaskAmbientScheduleStateStore(app)
    scheduler.isExecuted('tc-task-1', '2026-10-07')
    getSharedAiTaskAmbientScheduleStateStore(app).markExecuted('tc-task-1', '2026-10-07')
    expect(scheduler.isExecuted('tc-task-1', '2026-10-07')).toBe(true)
    expect(getSharedAiTaskAmbientScheduleStateStore({})).not.toBe(scheduler)
  })
})
