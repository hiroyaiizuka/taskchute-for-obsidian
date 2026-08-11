import { TFile } from 'obsidian'

import { ProjectBoardService } from '../../src/services/projects'
import { ProjectFolderUnsetError } from '../../src/types'
import type { TaskChutePluginLike } from '../../src/types'

function createTFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/^.*\//, '').replace(/\.md$/, '')
  Object.setPrototypeOf(file, TFile.prototype)
  return file
}

type FrontmatterMap = Record<string, Record<string, unknown>>

function createPlugin(options: {
  folder: string | null
  frontmatters?: FrontmatterMap
  files?: string[]
  adapterExists?: (path: string) => Promise<boolean>
  onCreate?: (path: string, data: string) => void
  fileContents?: Record<string, string>
}): TaskChutePluginLike {
  const files = (options.files ?? []).map(createTFile)
  const frontmatters: FrontmatterMap = options.frontmatters ?? {}
  const fileContents = options.fileContents ?? {}

  const plugin = {
    app: {
      vault: {
        getMarkdownFiles: jest.fn(() => files),
        getAbstractFileByPath: jest.fn((path: string) => files.find((f) => f.path === path) ?? null),
        cachedRead: jest.fn(async (file: TFile) => fileContents[file.path] ?? ''),
        adapter: {
          exists: jest.fn(async (path: string) => {
            if (options.adapterExists) return options.adapterExists(path)
            return files.some((file) => file.path === path)
          }),
          mkdir: jest.fn(async () => {}),
          write: jest.fn(async (path: string, data: string) => {
            options.onCreate?.(path, data)
          }),
          read: jest.fn(async () => ''),
        },
        configDir: 'config',
        create: jest.fn(async (path: string, data: string) => {
          const file = createTFile(path)
          files.push(file)
          fileContents[path] = data
          options.onCreate?.(path, data)
          return file
        }),
      },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: frontmatters[file.path] ?? {},
        })),
      },
      fileManager: {
        processFrontMatter: jest.fn((_file: TFile, cb: (fm: Record<string, unknown>) => void) => {
          const key = _file.path
          const existing = frontmatters[key] ?? {}
          cb(existing)
          frontmatters[key] = existing
          return Promise.resolve()
        }),
      },
    },
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
      projectTitlePrefix: 'Project - ',
      projectTemplatePath: null,
    },
    pathManager: {
      getProjectFolderPath: () => options.folder,
      ensureFolderExists: jest.fn(async () => {}),
    },
    routineAliasService: {},
    dayStateService: {},
    saveSettings: jest.fn(),
    _log: jest.fn(),
    _notify: jest.fn(),
    manifest: {
      id: 'taskchute-plus',
      dir: 'taskchute-plus',
    },
  }

  return plugin as unknown as TaskChutePluginLike
}

describe('ProjectBoardService', () => {
  test('throws when project folder unset', () => {
    const plugin = createPlugin({ folder: null })
    const service = new ProjectBoardService(plugin)

    expect(() => service.listProjectFiles()).toThrow(ProjectFolderUnsetError)
  })

  test('loadProjectItems normalizes status and title', () => {
    const frontmatter: FrontmatterMap = {
      'Projects/Alpha.md': {
        title: 'Alpha Project',
        status: 'in progress',
        order: '4',
        created: '2025-10-01',
        updated: '2025-10-15',
        completed: '',
        notes: 'Main initiative',
      },
      'Projects/Beta.md': {
        // Missing title & status, should default
      },
    }

    const plugin = createPlugin({
      folder: 'Projects',
      frontmatters: frontmatter,
      files: ['Projects/Alpha.md', 'Projects/Beta.md', 'Other/Ignore.md'],
    })

    const service = new ProjectBoardService(plugin)
    const items = service.loadProjectItems()

    expect(items).toHaveLength(2)

    const alpha = items.find((item) => item.basename === 'Alpha')
    expect(alpha?.status).toBe('in-progress')
    expect(alpha?.order).toBe(4)
    expect(alpha?.displayTitle).toBe('Alpha Project')
    expect(alpha?.created).toBe('2025-10-01')
    expect(alpha?.completed).toBeUndefined()
    expect(alpha?.notes).toBe('Main initiative')

    const beta = items.find((item) => item.basename === 'Beta')
    expect(beta?.status).toBe('todo')
    expect(beta?.displayTitle).toBe('Beta')
  })

  test('updateProjectFrontmatter writes normalized values back', async () => {
    const frontmatter: FrontmatterMap = {
      'Projects/Alpha.md': {
        title: 'Alpha',
        status: 'todo',
      },
    }

    const plugin = createPlugin({
      folder: 'Projects',
      frontmatters: frontmatter,
      files: ['Projects/Alpha.md'],
    })

    const service = new ProjectBoardService(plugin)
    const file = service.listProjectFiles()[0]

    await service.updateProjectFrontmatter(file, (snapshot) => {
      snapshot.status = 'done'
      snapshot.order = 1
      snapshot.updated = '2025-10-17T12:00:00Z'
      snapshot.completed = '2025-10-17'
    })

    const updatedItems = service.loadProjectItems()
    const item = updatedItems[0]

    expect(item.status).toBe('done')
    expect(item.order).toBe(1)
    expect(item.updated).toBeUndefined()
    expect(item.completed).toBe('2025-10-17')
  })

  test('updateProjectStatus clears completed metadata when moving to done', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-10-18T09:30:00Z'))
    try {
      const frontmatter: FrontmatterMap = {
        'Projects/Alpha.md': {
          title: 'Alpha',
          status: 'todo',
          completed: '2025-10-15',
        },
      }

      const plugin = createPlugin({
        folder: 'Projects',
        frontmatters: frontmatter,
        files: ['Projects/Alpha.md'],
      })

      const service = new ProjectBoardService(plugin)
      await service.updateProjectStatus('Projects/Alpha.md', 'done')

      const item = service.loadProjectItems()[0]
      expect(item.status).toBe('done')
      expect(item.completed).toBeUndefined()
      expect(frontmatter['Projects/Alpha.md'].completed).toBeUndefined()
      expect(frontmatter['Projects/Alpha.md'].updated).toBeUndefined()
      expect(frontmatter['Projects/Alpha.md'].created).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('createProject generates file with normalized metadata', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-10-18T09:30:00Z'))
    try {
      const frontmatter: FrontmatterMap = {}
      const created: { path?: string; data?: string } = {}

    const plugin = createPlugin({
      folder: 'Projects',
      frontmatters: frontmatter,
      files: [],
      adapterExists: async () => false,
      onCreate: (path, data) => {
        created.path = path
        created.data = data
        const match = data.match(/---\n([\s\S]*?)\n---/)
        if (match) {
          const fm: Record<string, unknown> = {}
          match[1]
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .forEach((line) => {
              const [key, ...rest] = line.split(':')
              if (!key) return
              fm[key.trim()] = rest.join(':').trim()
            })
          frontmatter[path] = fm
        }
      },
    })

    const service = new ProjectBoardService(plugin)

    const item = await service.createProject({
      title: 'New Initiative',
      status: 'in-progress',
    })

    expect(created.path).toBe('Projects/Project - New Initiative.md')
    expect(item.status).toBe('in-progress')
    expect(item.displayTitle).toBe('New Initiative')
    expect(item.title).toBe('Project - New Initiative')
    expect(frontmatter[created.path!].title).toBeUndefined()
    expect(frontmatter[created.path!].status).toBe('in-progress')
    expect(frontmatter[created.path!].start).toBe('2025-10-18')
    expect(frontmatter[created.path!].created).toBeUndefined()
    expect(frontmatter[created.path!].updated).toBeUndefined()
    expect(frontmatter[created.path!].notes).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('createProject copies template content and overrides metadata', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-10-18T09:30:00Z'))
    try {
      const templatePath = 'Templates/ProjectTemplate.md'
      const frontmatters: FrontmatterMap = {
        [templatePath]: {
          title: 'Template Title',
          status: 'todo',
          notes: 'Template note',
        },
      }
      const created: { path?: string; data?: string } = {}

      const plugin = createPlugin({
        folder: 'Projects',
        frontmatters,
        files: ['Projects/.gitkeep', templatePath],
        adapterExists: async () => false,
        onCreate: (path, data) => {
          created.path = path
          created.data = data
        },
        fileContents: {
          [templatePath]: '---\ntitle: Template Title\nstatus: todo\nnotes: Template note\n---\n# Body\n',
        },
      })
      plugin.settings.projectTemplatePath = templatePath

      const service = new ProjectBoardService(plugin)
      const item = await service.createProject({
        title: 'Project Phoenix',
        status: 'done',
      })

      expect(created.data).toContain('# Body')
      expect(item.status).toBe('done')
      expect(item.title).toBe('Project - Project Phoenix')
      expect(item.displayTitle).toBe('Project Phoenix')
      expect(frontmatters[item.path].status).toBe('done')
      expect(frontmatters[item.path].notes).toBeUndefined()
      expect(frontmatters[item.path].title).toBeUndefined()
      expect(frontmatters[item.path].start).toBe('2025-10-18')
      expect(frontmatters[item.path].created).toBeUndefined()
      expect(frontmatters[item.path].updated).toBeUndefined()
      expect(frontmatters[templatePath].title).toBe('Template Title')
    } finally {
      jest.useRealTimers()
    }
  })
})
