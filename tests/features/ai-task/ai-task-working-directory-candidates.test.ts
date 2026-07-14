import type { App } from 'obsidian'
import { TFile } from 'obsidian'

import { collectAiTaskWorkingDirectoryCandidates } from '../../../src/features/ai-task/services/AiTaskWorkingDirectoryCandidates'

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

describe('collectAiTaskWorkingDirectoryCandidates', () => {
  test('collects cwd values from every AI task under the configured task folder only', () => {
    const rootAiTask = file('TaskChute/Task/Root AI.md')
    const nestedAiTask = file('TaskChute/Task/Nested/Nested AI.md')
    const humanTask = file('TaskChute/Task/Human.md')
    const invalidAiTask = file('TaskChute/Task/Invalid AI.md')
    const nonMarkdown = file('TaskChute/Task/ignored.json')
    const root = folder('TaskChute/Task', [
      rootAiTask,
      humanTask,
      invalidAiTask,
      nonMarkdown,
      folder('TaskChute/Task/Nested', [nestedAiTask]),
    ])
    const frontmatterByPath = new Map<string, Record<string, unknown>>([
      [
        rootAiTask.path,
        { ai_task: true, ai_task_cwd: '  /Users/example/root-project/  ' },
      ],
      [nestedAiTask.path, { ai_task: true, ai_task_cwd: '/Users/example/nested' }],
      [humanTask.path, { ai_task: false, ai_task_cwd: '/Users/example/human' }],
      [invalidAiTask.path, { ai_task: true, ai_task_cwd: 42 }],
      [nonMarkdown.path, { ai_task: true, ai_task_cwd: '/Users/example/json' }],
    ])
    const getMarkdownFiles = jest.fn(() => {
      throw new Error('full-vault enumeration must not be used')
    })
    const getFiles = jest.fn(() => {
      throw new Error('full-vault enumeration must not be used')
    })
    const getAbstractFileByPath = jest.fn((path: string) =>
      path === 'TaskChute/Task' ? root : null,
    )
    const getFileCache = jest.fn((candidate: TFile) => ({
      frontmatter: frontmatterByPath.get(candidate.path),
    }))
    const app = {
      vault: {
        getAbstractFileByPath,
        getMarkdownFiles,
        getFiles,
      },
      metadataCache: { getFileCache },
    } as unknown as App

    expect(
      collectAiTaskWorkingDirectoryCandidates(app, 'TaskChute/Task'),
    ).toEqual(['/Users/example/root-project/', '/Users/example/nested'])
    expect(getAbstractFileByPath).toHaveBeenCalledTimes(1)
    expect(getAbstractFileByPath).toHaveBeenCalledWith('TaskChute/Task')
    expect(getMarkdownFiles).not.toHaveBeenCalled()
    expect(getFiles).not.toHaveBeenCalled()
    expect(getFileCache).toHaveBeenCalledTimes(4)
  })

  test('returns an empty list without metadata reads when the task folder is missing', () => {
    const getAbstractFileByPath = jest.fn(() => null)
    const getFileCache = jest.fn()
    const app = {
      vault: { getAbstractFileByPath },
      metadataCache: { getFileCache },
    } as unknown as App

    expect(
      collectAiTaskWorkingDirectoryCandidates(app, 'TaskChute/Task'),
    ).toEqual([])
    expect(getFileCache).not.toHaveBeenCalled()
  })

  test('skips one broken metadata cache entry and keeps collecting later tasks', () => {
    const broken = file('TaskChute/Task/Broken.md')
    const healthy = file('TaskChute/Task/Healthy.md')
    const root = folder('TaskChute/Task', [broken, healthy])
    const app = {
      vault: { getAbstractFileByPath: jest.fn(() => root) },
      metadataCache: {
        getFileCache: jest.fn((candidate: TFile) => {
          if (candidate === broken) throw new Error('broken cache entry')
          return {
            frontmatter: {
              ai_task: true,
              ai_task_cwd: '/Users/example/healthy',
            },
          }
        }),
      },
    } as unknown as App

    expect(
      collectAiTaskWorkingDirectoryCandidates(app, 'TaskChute/Task'),
    ).toEqual(['/Users/example/healthy'])
  })
})
