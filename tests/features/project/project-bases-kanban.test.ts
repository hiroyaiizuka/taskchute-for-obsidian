import { TFile, requireApiVersion, type App } from 'obsidian'
import {
  PROJECT_BASE_FILE_NAME,
  ensureProjectBase,
  isBasesKanbanSupported,
  projectBaseContent,
} from '@/features/project/services/ProjectBasesKanban'

function vault(files: Record<string, unknown> = {}) {
  const created: Array<[string, string]> = []
  const folders: string[] = []
  const app = {
    vault: {
      getAbstractFileByPath: jest.fn((path: string) => files[path] ?? null),
      create: jest.fn(async (path: string, data: string) => {
        created.push([path, data])
        const file = new TFile()
        file.path = path
        return file
      }),
      createFolder: jest.fn(async (path: string) => {
        folders.push(path)
      }),
    },
  } as unknown as App
  return { app, created, folders }
}

describe('ProjectBasesKanban', () => {
  test('the base is a kanban of the folder notes grouped by status, with no fixed column order', () => {
    const content = projectBaseContent('Projects', 'プロジェクト')
    expect(content).toBe(
      [
        'filters:',
        '  and:',
        `    - 'file.inFolder("Projects")'`,
        `    - 'file.ext == "md"'`,
        'views:',
        '  - type: kanban',
        `    name: 'プロジェクト'`,
        '    groupBy:',
        '      property: note.status',
        '      direction: ASC',
        '    order:',
        '      - file.name',
        '',
      ].join('\n'),
    )
    // A fixed order would hide every status it leaves out (in_progress, completed, …).
    expect(content).not.toContain('groupOrder')
  })

  test('quotes in the folder or view name stay inside their strings', () => {
    const content = projectBaseContent(`Work/"Q4" it's`, `Bob's`)
    expect(content).toContain(`    - 'file.inFolder("Work/\\"Q4\\" it''s")'`)
    expect(content).toContain(`    name: 'Bob''s'`)
  })

  test('creates the base in the projects folder (and the folder) when missing', async () => {
    const { app, created, folders } = vault()
    const file = await ensureProjectBase(app, 'Projects', 'Projects')
    expect(file.path).toBe(`Projects/${PROJECT_BASE_FILE_NAME}`)
    expect(folders).toEqual(['Projects'])
    expect(created[0][0]).toBe(`Projects/${PROJECT_BASE_FILE_NAME}`)
  })

  test('an existing base is opened as it is, never rewritten', async () => {
    const existing = new TFile()
    existing.path = `Projects/${PROJECT_BASE_FILE_NAME}`
    const { app, created } = vault({ Projects: {}, [existing.path]: existing })
    await expect(ensureProjectBase(app, 'Projects', 'Projects')).resolves.toBe(existing)
    expect(created).toEqual([])
  })

  test('the kanban needs Obsidian 1.14', () => {
    const version = requireApiVersion as jest.Mock
    version.mockReturnValueOnce(false)
    expect(isBasesKanbanSupported()).toBe(false)
    expect(version).toHaveBeenLastCalledWith('1.14.0')
  })
})
