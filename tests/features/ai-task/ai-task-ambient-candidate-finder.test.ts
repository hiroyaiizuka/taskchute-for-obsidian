import type { App } from 'obsidian'
import { TFile } from 'obsidian'

import {
  AiTaskAmbientCandidateFinder,
  findAiTaskAmbientCandidates,
} from '../../../src/features/ai-task/services/AiTaskAmbientCandidateFinder'

function file(path: string): TFile {
  const candidate = new TFile()
  candidate.path = path
  candidate.basename = path.split('/').pop()?.replace(/\.[^.]+$/u, '') ?? path
  candidate.extension = path.split('.').pop() ?? ''
  return candidate
}

function folder(path: string, children: unknown[] = []): {
  path: string
  children: unknown[]
} {
  return { path, children }
}

function createApp(
  frontmatterByPath: Record<string, Record<string, unknown> | Error>,
): App {
  const files = Object.keys(frontmatterByPath).map(file)
  const root = folder('TaskChute/Task', files)
  return {
    vault: {
      getAbstractFileByPath: jest.fn((path: string) =>
        path === 'TaskChute/Task' ? root : null,
      ),
    },
    metadataCache: {
      getFileCache: jest.fn((candidate: TFile) => {
        const value = frontmatterByPath[candidate.path]
        if (value instanceof Error) throw value
        return { frontmatter: value }
      }),
    },
  } as unknown as App
}

function ambient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'ambient-id',
    ai_task: true,
    ai_task_host: 'claude',
    isRoutine: true,
    routine_type: 'daily',
    routine_enabled: true,
    scheduled_time: '08:00',
    ...overrides,
  }
}

describe('AiTaskAmbientCandidateFinder', () => {
  test('finds a due AI routine at and after its scheduled minute', () => {
    const app = createApp({
      'TaskChute/Task/Ambient.md': ambient(),
    })
    const finder = new AiTaskAmbientCandidateFinder()

    expect(finder.find(app, 'TaskChute/Task', new Date(2026, 6, 15, 7, 59))).toEqual([])
    expect(finder.find(app, 'TaskChute/Task', new Date(2026, 6, 15, 8, 0, 59))).toEqual([
      {
        identity: 'taskId:ambient-id',
        path: 'TaskChute/Task/Ambient.md',
        dateKey: '2026-07-15',
        scheduledTime: '08:00',
        taskId: 'ambient-id',
      },
    ])
    expect(finder.find(app, 'TaskChute/Task', new Date(2026, 6, 15, 22, 0))).toHaveLength(1)
  })

  test('supports legacy scheduled time and path identity', () => {
    const app = createApp({
      'TaskChute/Task/Legacy.md': ambient({
        taskId: undefined,
        scheduled_time: undefined,
        '開始時刻': '09:30',
      }),
    })

    expect(
      findAiTaskAmbientCandidates(
        app,
        'TaskChute/Task',
        new Date(2026, 6, 15, 9, 30),
      ),
    ).toEqual([
      {
        identity: 'path:TaskChute/Task/Legacy.md',
        path: 'TaskChute/Task/Legacy.md',
        dateKey: '2026-07-15',
        scheduledTime: '09:30',
      },
    ])
  })

  test.each([
    ['human task', { ai_task: false }],
    ['non-routine AI task', { isRoutine: false }],
    ['disabled routine', { routine_enabled: false }],
    ['missing time', { scheduled_time: undefined }],
    ['malformed time', { scheduled_time: '8' }],
    ['out-of-range hour', { scheduled_time: '24:00' }],
    ['out-of-range minute', { scheduled_time: '08:60' }],
  ])('skips %s', (_label, overrides) => {
    const app = createApp({
      'TaskChute/Task/Skip.md': ambient(overrides),
    })

    expect(
      findAiTaskAmbientCandidates(
        app,
        'TaskChute/Task',
        new Date(2026, 6, 15, 12, 0),
      ),
    ).toEqual([])
  })

  test('normalizes the existing H:mm time format', () => {
    const app = createApp({
      'TaskChute/Task/Single digit hour.md': ambient({
        scheduled_time: '8:00',
      }),
    })

    expect(
      findAiTaskAmbientCandidates(
        app,
        'TaskChute/Task',
        new Date(2026, 6, 15, 8, 0),
      ),
    ).toEqual([
      expect.objectContaining({ scheduledTime: '08:00' }),
    ])
  })

  test('skips active Obsidian-linked routines but allows disabled linkage', () => {
    const linked = createApp({
      'TaskChute/Task/Linked.md': ambient({
        obsidian_sync: {
          enabled: true,
          taskTitle: 'CEO review',
          matchType: 'exact',
        },
      }),
    })
    const disabledLink = createApp({
      'TaskChute/Task/Disabled link.md': ambient({
        obsidian_sync: {
          enabled: false,
          taskTitle: 'CEO review',
          matchType: 'exact',
        },
      }),
    })
    const now = new Date(2026, 6, 15, 12, 0)

    expect(findAiTaskAmbientCandidates(linked, 'TaskChute/Task', now)).toEqual([])
    expect(
      findAiTaskAmbientCandidates(disabledLink, 'TaskChute/Task', now),
    ).toHaveLength(1)
  })

  test('uses RoutineService due semantics, including target-date moves', () => {
    // 2026-07-15 is Wednesday. A Thursday weekly routine is not due.
    const app = createApp({
      'TaskChute/Task/Weekly.md': ambient({
        routine_type: 'weekly',
        routine_weekday: 4,
      }),
      'TaskChute/Task/Moved.md': ambient({
        taskId: 'moved-id',
        routine_start: '2026-07-01',
        target_date: '2026-07-15',
      }),
    })

    expect(
      findAiTaskAmbientCandidates(
        app,
        'TaskChute/Task',
        new Date(2026, 6, 15, 12, 0),
      ).map((candidate) => candidate.identity),
    ).toEqual(['taskId:moved-id'])
  })

  test('deduplicates copied task IDs and isolates broken metadata entries', () => {
    const app = createApp({
      'TaskChute/Task/Broken.md': new Error('cache broken'),
      'TaskChute/Task/First.md': ambient({ taskId: 'same-id' }),
      'TaskChute/Task/Second.md': ambient({ taskId: 'same-id' }),
      'TaskChute/Task/Healthy.md': ambient({ taskId: 'healthy-id' }),
    })

    expect(
      findAiTaskAmbientCandidates(
        app,
        'TaskChute/Task',
        new Date(2026, 6, 15, 12, 0),
      ).map((candidate) => candidate.identity),
    ).toEqual(['taskId:same-id', 'taskId:healthy-id'])
  })

  test('returns no candidates when the configured folder is absent', () => {
    const app = {
      vault: { getAbstractFileByPath: jest.fn(() => null) },
      metadataCache: { getFileCache: jest.fn() },
    } as unknown as App

    expect(
      findAiTaskAmbientCandidates(
        app,
        'TaskChute/Task',
        new Date(2026, 6, 15, 12, 0),
      ),
    ).toEqual([])
    expect(app.metadataCache.getFileCache).not.toHaveBeenCalled()
  })
})
