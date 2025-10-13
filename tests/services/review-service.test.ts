import { ReviewService } from '../../src/features/review/services/ReviewService'
import type { TaskChutePluginLike } from '../../src/types'
import type { TFile } from 'obsidian'

const { TFile: TFileMock } = jest.requireMock('obsidian') as {
  TFile: { prototype: TFile }
}

const createMockTFile = (path: string): TFile => {
  const file = Object.create(TFileMock.prototype) as TFile & {
    path: string
    basename: string
    extension: string
  }
  file.path = path
  const dotIndex = path.lastIndexOf('.')
  file.basename = dotIndex > -1 ? path.substring(0, dotIndex) : path
  file.extension = dotIndex > -1 ? path.substring(dotIndex + 1) : ''
  return file
}

describe('ReviewService', () => {
  const createPluginStub = () => {
    const vault = {
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      create: jest.fn(),
    }

    const pathManager = {
      getReviewDataPath: jest.fn().mockReturnValue('TaskChute/Review'),
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log'),
    }

    const plugin = {
      app: { vault },
      settings: {
        reviewTemplatePath: 'Templates/review.md',
        reviewFileNamePattern: 'Daily - {{date}}.md',
        useOrderBasedSort: true,
        slotKeys: {},
      },
      pathManager,
      routineAliasService: {} as unknown,
      dayStateService: {} as unknown,
      saveSettings: jest.fn(),
      _log: jest.fn(),
      _notify: jest.fn(),
      manifest: { id: 'taskchute-plus' },
    } as unknown as TaskChutePluginLike & { app: { vault: typeof vault } }

    return { plugin, vault, pathManager }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('uses the custom template when available', async () => {
    const { plugin, vault } = createPluginStub()
    const templateFile = createMockTFile('Templates/review.md')
    const createdFile = createMockTFile('TaskChute/Review/Daily - 2025-10-13.md')

    vault.getAbstractFileByPath.mockImplementation((path: string) => {
      if (path === 'TaskChute/Review/Daily - 2025-10-13.md') return null
      if (path === 'Templates/review.md') return templateFile
      return null
    })
    vault.read.mockResolvedValue('## Custom {{date}} -> {{logDataPath}}')
    vault.create.mockResolvedValue(createdFile)

    const service = new ReviewService(plugin)
    const file = await service.ensureReviewFile('2025-10-13')

    expect(file).toBe(createdFile)
    expect(vault.create).toHaveBeenCalledWith(
      'TaskChute/Review/Daily - 2025-10-13.md',
      expect.stringContaining('2025-10-13'),
    )
    expect(vault.create).toHaveBeenCalledWith(
      'TaskChute/Review/Daily - 2025-10-13.md',
      expect.stringContaining('TaskChute/Log'),
    )
    expect(vault.read).toHaveBeenCalledWith(templateFile)
    expect(plugin._notify).not.toHaveBeenCalled()
  })

  test('falls back to default template when custom file is missing', async () => {
    const { plugin, vault } = createPluginStub()
    const createdFile = createMockTFile('TaskChute/Review/Daily - 2025-10-14.md')

    vault.getAbstractFileByPath.mockImplementation((path: string) => {
      if (path === 'TaskChute/Review/Daily - 2025-10-14.md') return null
      return null
    })
    vault.create.mockResolvedValue(createdFile)

    const service = new ReviewService(plugin)
    const file = await service.ensureReviewFile('2025-10-14')

    expect(file).toBe(createdFile)
    expect(vault.read).not.toHaveBeenCalled()
    expect(vault.create).toHaveBeenCalledWith(
      'TaskChute/Review/Daily - 2025-10-14.md',
      '',
    )
    expect(plugin._notify).toHaveBeenCalledWith(
      expect.stringContaining('Templates/review.md'),
    )
  })

  test('applies review file name pattern tokens', async () => {
    const { plugin } = createPluginStub()
    plugin.settings.reviewFileNamePattern = 'Review {{year}}{{month}}{{day}}'

    const service = new ReviewService(plugin)
    const fileName = service.getReviewFileName('2025-10-16')

    expect(fileName).toBe('Review 20251016.md')
  })

  test('auto-appends extension when pattern omits .md', async () => {
    const { plugin } = createPluginStub()
    plugin.settings.reviewFileNamePattern = 'Review-{{date}}'

    const service = new ReviewService(plugin)
    const fileName = service.getReviewFileName('2025-10-17')

    expect(fileName).toBe('Review-2025-10-17.md')
  })
})
