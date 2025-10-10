import { TFile } from 'obsidian'
import type { TaskChuteSettings, TaskChutePluginLike } from '../../src/types'
import ProjectController from '../../src/ui/project/ProjectController'

function createTFile(path: string) {
  const f = new TFile()
  f.path = path
  f.basename = path.replace(/^.*\//, '').replace(/\.md$/, '')
  Object.setPrototypeOf(f, TFile.prototype)
  return f
}

type AppStub = {
  vault: {
    getMarkdownFiles: () => TFile[]
    getAbstractFileByPath: (path: string) => unknown
  }
  metadataCache: {
    getFileCache: (file: TFile) => unknown
  }
  setting?: unknown
  workspace: unknown
}

function makeController(options: Partial<TaskChuteSettings> & { files: string[]; tagged?: string[] }) {
  const projectFolder = options.projectsFolder ?? 'PROJ'
  const files = options.files.map(createTFile)
  const taggedSet = new Set(options.tagged ?? [])

  const plugin = {
    app: {
      vault: {
        getMarkdownFiles: jest.fn(() => files),
        getAbstractFileByPath: jest.fn(),
      },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => {
          if (taggedSet.has(file.path)) return { tags: [{ tag: '#project' }] }
          return {}
        }),
      },
      setting: undefined,
      workspace: {},
    },
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
      locationMode: 'vaultRoot',
      projectsFolder: projectFolder,
      projectsFilterEnabled: options.projectsFilterEnabled ?? false,
      projectsFilter: Object.assign(
        {
          prefixes: [],
          tags: [],
          includeSubfolders: true,
          matchMode: 'OR',
          limit: 50,
          trimPrefixesInUI: true,
          transformName: false,
        },
        options.projectsFilter || {},
      ),
    } as unknown as TaskChuteSettings,
    pathManager: {
      getProjectFolderPath: () => projectFolder,
    },
  } as unknown as TaskChutePluginLike & { app: AppStub }

  const controller = new ProjectController({
    app: plugin.app,
    plugin,
    tv: (_key: string, fallback: string) => fallback,
    getInstanceDisplayTitle: () => 'Sample task',
    renderTaskList: () => {},
    getTaskListElement: () => document.createElement('div'),
  })

  return controller
}

async function getProjects(controller: ProjectController) {
  const files = await controller.getProjectFiles()
  return files.map((f) => f.path)
}

describe('Project candidates filtering', () => {
  test('filter OFF returns all files under project folder', async () => {
    const controller = makeController({
      files: [
        'PROJ/A.md',
        'PROJ/Project - Alpha.md',
        'PROJ/Sub/Project - Beta.md',
        'PROJ/Note.md',
        'OTHER/B.md',
      ],
      projectsFilterEnabled: false,
    })

    const paths = await getProjects(controller)
    expect(paths.sort()).toEqual(
      ['PROJ/A.md', 'PROJ/Project - Alpha.md', 'PROJ/Sub/Project - Beta.md', 'PROJ/Note.md'].sort(),
    )
  })

  test('filter by prefixes only', async () => {
    const controller = makeController({
      files: ['PROJ/Project - Alpha.md', 'PROJ/Sub/Project - Beta.md', 'PROJ/Note.md'],
      projectsFilterEnabled: true,
      projectsFilter: { prefixes: ['Project - '], tags: [] },
    })
    const paths = await getProjects(controller)
    expect(paths.sort()).toEqual(
      ['PROJ/Project - Alpha.md', 'PROJ/Sub/Project - Beta.md'].sort(),
    )
  })

  test('filter by tags only', async () => {
    const controller = makeController({
      files: ['PROJ/Project - Alpha.md', 'PROJ/Note.md'],
      tagged: ['PROJ/Note.md'],
      projectsFilterEnabled: true,
      projectsFilter: { prefixes: [], tags: ['project'] },
    })
    const paths = await getProjects(controller)
    expect(paths).toEqual(['PROJ/Note.md'])
  })

  test('AND mode requires both prefix and tag', async () => {
    const controller = makeController({
      files: ['PROJ/Project - Alpha.md', 'PROJ/Note.md'],
      tagged: ['PROJ/Project - Alpha.md'],
      projectsFilterEnabled: true,
      projectsFilter: { prefixes: ['Project - '], tags: ['project'], matchMode: 'AND' },
    })
    const paths = await getProjects(controller)
    expect(paths).toEqual(['PROJ/Project - Alpha.md'])
  })

  test('includeSubfolders=false excludes nested files', async () => {
    const controller = makeController({
      files: ['PROJ/Project - Alpha.md', 'PROJ/Sub/Project - Beta.md'],
      projectsFilterEnabled: true,
      projectsFilter: { prefixes: ['Project - '], includeSubfolders: false },
    })
    const paths = await getProjects(controller)
    expect(paths).toEqual(['PROJ/Project - Alpha.md'])
  })
})
