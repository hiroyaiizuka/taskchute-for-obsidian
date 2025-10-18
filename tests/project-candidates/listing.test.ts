import { TFile } from 'obsidian'
import type { TaskChutePluginLike, TaskChuteSettings } from '../../src/types'
import ProjectController from '../../src/ui/project/ProjectController'

function createFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/^.*\//, '').replace(/\.md$/, '')
  Object.setPrototypeOf(file, TFile.prototype)
  return file
}

function createController(files: string[], options: Partial<TaskChuteSettings> = {}) {
  const projectFolder = options.projectsFolder ?? 'Projects'
  const markdownFiles = files.map(createFile)

  const statusMap: Record<string, string> = {}
  const plugin = {
    app: {
      vault: {
        getMarkdownFiles: jest.fn(() => markdownFiles),
        getAbstractFileByPath: jest.fn(),
      },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: statusMap[file.path] ? { status: statusMap[file.path] } : {},
        })),
      },
      setting: undefined,
      workspace: {},
    },
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
      locationMode: 'vaultRoot',
      projectsFolder: projectFolder,
      projectTemplatePath: null,
    } as unknown as TaskChuteSettings,
    pathManager: {
      getProjectFolderPath: () => projectFolder,
    },
  } as unknown as TaskChutePluginLike

  return new ProjectController({
    app: plugin.app,
    plugin,
    tv: (_key, fallback) => fallback,
    getInstanceDisplayTitle: () => 'Task',
    renderTaskList: () => {},
    getTaskListElement: () => document.createElement('div'),
  })
}

describe('ProjectController getProjectFiles', () => {
  test('returns only todo/in-progress projects under the configured project folder', async () => {
    const controller = createController([
      'Projects/Alpha.md',
      'Projects/Project - Beta.md',
      'Projects/Sub/Delta.md',
      'Other/Foo.md',
    ])

    const metadata = (controller as unknown as { host: { app: TaskChutePluginLike['app'] } })
      .host.app.metadataCache.getFileCache as jest.Mock
    metadata.mockImplementation((file: TFile) => {
      const map: Record<string, string> = {
        'Projects/Alpha.md': 'todo',
        'Projects/Project - Beta.md': 'done',
        'Projects/Sub/Delta.md': 'in-progress',
      }
      return { frontmatter: map[file.path] ? { status: map[file.path] } : {} }
    })

    const files = await controller.getProjectFiles()
    expect(files.map((file) => file.path)).toEqual([
      'Projects/Alpha.md',
      'Projects/Sub/Delta.md',
    ])
  })

  test('ignores filters and respects nested subfolders', async () => {
    const controller = createController([
      'Projects/Sub/One.md',
      'Projects/Sub/Nested/Two.md',
      'Projects/Three.md',
    ])

    const metadata = (controller as unknown as { host: { app: TaskChutePluginLike['app'] } })
      .host.app.metadataCache.getFileCache as jest.Mock
    metadata.mockImplementation((file: TFile) => {
      const map: Record<string, string> = {
        'Projects/Sub/One.md': 'todo',
        'Projects/Sub/Nested/Two.md': 'in-progress',
        'Projects/Three.md': 'done',
      }
      return { frontmatter: map[file.path] ? { status: map[file.path] } : {} }
    })

    const files = await controller.getProjectFiles()
    expect(files.map((file) => file.path)).toEqual([
      'Projects/Sub/Nested/Two.md',
      'Projects/Sub/One.md',
    ])
  })
})
