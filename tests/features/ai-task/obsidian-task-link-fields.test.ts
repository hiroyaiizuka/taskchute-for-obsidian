/**
 * @jest-environment jsdom
 */

import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import { createObsidianTaskLinkFields } from '../../../src/features/ai-task/ui/ObsidianTaskLinkFields'

jest.mock('obsidian')

function createFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.split('/').pop()?.replace(/\.md$/u, '') ?? path
  file.extension = 'md'
  return file
}

describe('ObsidianTaskLinkFields', () => {
  test('offers human tasks from the configured task folder without enumerating the vault', () => {
    const currentAi = createFile('TASKS/AI CEO.md')
    const human = createFile('TASKS/CEO review.md')
    const otherAi = createFile('TASKS/AI helper.md')
    const getMarkdownFiles = jest.fn(() => [currentAi, human, otherAi])
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) =>
          path === 'TASKS'
            ? { path: 'TASKS', children: [currentAi, human, otherAi] }
            : null,
        ),
        getMarkdownFiles,
      },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: file === human
            ? { name: 'Alias that runtime does not display' }
            : { ai_task: true },
        })),
      },
    } as unknown as App

    const controller = createObsidianTaskLinkFields({
      parent: document.body,
      doc: document,
      app,
      taskFolderPath: 'TASKS',
      excludePath: currentAi.path,
      initialValue: { enabled: true, taskTitle: '', matchType: 'exact' },
      translate: (_key, fallback) => fallback,
    })

    const input = document.querySelector<HTMLInputElement>(
      '.obsidian-task-link-title',
    )
    input?.dispatchEvent(new Event('focus'))

    const suggestions = Array.from(document.querySelectorAll(
      '.obsidian-task-link-suggestion',
    )).map((element) => element.textContent)
    expect(suggestions).toEqual(['CEO review'])
    expect(suggestions).not.toContain('Alias that runtime does not display')
    expect(getMarkdownFiles).not.toHaveBeenCalled()

    controller.destroy()
  })
})
