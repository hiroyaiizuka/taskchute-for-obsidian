import { setObsidianLanguage } from '@tests/utils/locale'
import { LogView } from '@/features/log/views/LogView'
import type { DayComment, HeatmapDayDetail, HeatmapDayStats, HeatmapYearData, TaskChuteSettings } from '@/types'

type TestVault = {
  getAbstractFileByPath: jest.Mock
  read: jest.Mock
  create: jest.Mock
  modify: jest.Mock
}

type TestWorkspace = {
  getLeavesOfType: jest.Mock
  getRightLeaf: jest.Mock
  setActiveLeaf: jest.Mock
}

type TestPlugin = {
  app: {
    vault: TestVault
    fileManager: { trashFile: jest.Mock }
    workspace: TestWorkspace
  }
  pathManager: {
    getTaskFolderPath: () => string
    getProjectFolderPath: () => string
    getLogDataPath: () => string
    getReviewDataPath: () => string
    ensureFolderExists: (path: string) => Promise<void>
    getLogYearPath: (year: number | string) => string
    validatePath: (path: string) => { valid: boolean; error?: string }
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => { void Promise.resolve().then(() => resolve()) })

// empty / createEl / setAttr come from tests/setup/obsidian-dom-globals.ts,
// which installs them on Node.prototype before any test body runs.

describe('LogView heatmap detail panel', () => {
  let rafSpy: jest.SpyInstance<number, [FrameRequestCallback]> | null = null

beforeAll(() => {
  setObsidianLanguage('ja')
})

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-09-26T09:00:00Z'))
    rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 0
      })
  })

  afterEach(() => {
    if (rafSpy) {
      rafSpy.mockRestore()
      rafSpy = null
    }
    jest.useRealTimers()
    document.body.innerHTML = ''
  })

  const createPlugin = () => {
    const mockVault: TestVault = {
      getAbstractFileByPath: jest.fn(() => null),
      read: jest.fn(),
      create: jest.fn(),
      modify: jest.fn(),
    }

    const plugin: TestPlugin = {
      app: {
        vault: mockVault,
        fileManager: {
          trashFile: jest.fn(),
        },
        workspace: {
          getLeavesOfType: jest.fn(() => []),
          getRightLeaf: jest.fn(() => null),
          setActiveLeaf: jest.fn(),
        },
      },
      pathManager: {
        getTaskFolderPath: () => 'TASKS',
        getProjectFolderPath: () => 'PROJECTS',
        getLogDataPath: () => 'LOGS',
        getReviewDataPath: () => 'REVIEWS',
        ensureFolderExists: jest.fn().mockResolvedValue(undefined),
        getLogYearPath: (year: number | string) => `LOGS/${year}`,
        validatePath: () => ({ valid: true }),
      },
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    return { plugin, container }
  }

  const createDetail = (date: string, overrides: Partial<HeatmapDayDetail> = {}): HeatmapDayDetail => ({
    date,
    satisfaction: 4,
    summary: {
      totalTasks: 2,
      completedTasks: 2,
      totalMinutes: 120,
      procrastinatedTasks: 0,
      completionRate: 1,
      avgFocusLevel: 4.5,
      avgEnergyLevel: 4,
      ...(overrides.summary ?? {}),
    },
    executions: [
      {
        id: `${date}-a`,
        title: '朝のルーティン',
        startTime: '07:30:00',
        stopTime: '08:00:00',
        durationSec: 1800,
        focusLevel: 5,
        energyLevel: 4,
        executionComment: 'スッキリ',
        project: 'Daily Review',
        projectPath: 'Project/Daily Review.md',
        isCompleted: true,
      },
    ],
    ...overrides,
  })

  test('renders today detail by default', async () => {
    const { plugin, container } = createPlugin()
    const view = new LogView(plugin as unknown as ConstructorParameters<typeof LogView>[0], container)

    const yearlyData: HeatmapYearData = {
      year: 2025,
      days: {
        '2025-09-26': { totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
      },
    }

    const heatmapService = (view as unknown as {
      heatmapService: {
        loadYearlyData: jest.Mock<Promise<HeatmapYearData>, [number]>
        loadDayDetail: jest.Mock<Promise<HeatmapDayDetail | null>, [string]>
      }
    }).heatmapService

    const loadYearly = jest
      .spyOn(heatmapService, 'loadYearlyData')
      .mockResolvedValue(yearlyData)
    const loadDetail = jest
      .spyOn(heatmapService, 'loadDayDetail')
      .mockResolvedValue(createDetail('2025-09-26'))

    await view.render()
    await flushMicrotasks()

    expect(loadYearly).toHaveBeenCalled()
    expect(loadDetail).toHaveBeenCalledWith('2025-09-26')

    const dateEl = container.querySelector('.heatmap-detail-date')
    expect(dateEl?.textContent).toContain('2025-09-26')

    const openButton = container.querySelector('.heatmap-detail-open-button')
    expect(openButton?.textContent).toBe('↗︎ 開く')
    const heading = container.querySelector('.heatmap-detail-heading')
    expect(heading?.contains(openButton ?? null)).toBe(true)

    const rows = container.querySelectorAll('.heatmap-detail-table tbody tr')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('朝のルーティン')
  })

  describe('comments (LEV-412)', () => {
    const at = (hhmm: string) => new Date(`2025-09-26T${hhmm}:00`).getTime()
    const comment = (id: string, hhmm: string, text: string, extra: Partial<DayComment> = {}): DayComment => ({
      id,
      at: at(hhmm),
      text,
      updatedAt: at(hhmm),
      ...extra,
    })

    const renderWith = async (comments: DayComment[], settings: Partial<TaskChuteSettings>) => {
      const { plugin, container } = createPlugin()
      const withComments = {
        ...plugin,
        settings,
        dayStateService: {
          loadDay: jest.fn(async () => ({ hiddenRoutines: [], deletedInstances: [], duplicatedInstances: [], slotOverrides: {}, orders: {}, comments })),
          getDateFromKey: (key: string) => new Date(`${key}T00:00:00`),
        },
      }
      const view = new LogView(withComments as unknown as ConstructorParameters<typeof LogView>[0], container)
      const heatmapService = (view as unknown as {
        heatmapService: {
          loadYearlyData: jest.Mock<Promise<HeatmapYearData>, [number]>
          loadDayDetail: jest.Mock<Promise<HeatmapDayDetail | null>, [string]>
        }
      }).heatmapService
      jest.spyOn(heatmapService, 'loadYearlyData').mockResolvedValue({
        year: 2025,
        days: { '2025-09-26': { totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 } },
      })
      const detail = createDetail('2025-09-26')
      detail.executions[0].instanceId = 'inst-a'
      jest.spyOn(heatmapService, 'loadDayDetail').mockResolvedValue(detail)
      await view.render()
      await flushMicrotasks()
      await flushMicrotasks()
      return container
    }

    const texts = (scope: Element | null, selector: string) =>
      Array.from(scope?.querySelectorAll(selector) ?? []).map((n) => n.textContent)

    const comments = [
      comment('c2', '07:50', '半分まで'),
      comment('c1', '07:35', 'はじめた'),
      comment('c3', '07:40', '消したもの', { deletedAt: at('07:41') }),
      comment('c4', '07:45', '別のタスク', { instanceId: 'inst-b' }),
      comment('d1', '21:00', '今日はよく進んだ'),
    ]
    comments[0].instanceId = 'inst-a'
    comments[1].instanceId = 'inst-a'
    comments[2].instanceId = 'inst-a'

    test("lists a task's comments from while it ran under its comment, oldest first", async () => {
      const container = await renderWith(comments, {})
      const cell = container.querySelector('.heatmap-detail-table tbody tr .heatmap-detail-comment')
      expect(cell?.querySelector('.heatmap-detail-execution-comment')?.textContent).toBe('スッキリ')
      expect(texts(cell, '.is-running li time')).toEqual(['07:35', '07:50'])
      expect(texts(cell, '.is-running .heatmap-detail-comment-text')).toEqual(['はじめた', '半分まで'])
      // Comments for the day are off: no section for them.
      expect(container.querySelector('.heatmap-detail-day-comments')).toBeNull()
    })

    test("shows the day's own comments under the table when they are turned on", async () => {
      const container = await renderWith(comments, { dayCommentsEnabled: true })
      const section = container.querySelector('.heatmap-detail-day-comments')
      expect(section?.querySelector('.heatmap-detail-day-comments__title')?.textContent).toContain('今日のコメント')
      expect(texts(section, '.heatmap-detail-comment-text')).toEqual(['今日はよく進んだ'])
    })

    test('shows only the comment written at the end when none were left while it ran', async () => {
      const container = await renderWith([], { dayCommentsEnabled: true })
      const cell = container.querySelector('.heatmap-detail-table tbody tr .heatmap-detail-comment')
      expect(cell?.textContent).toBe('スッキリ')
      expect(container.querySelector('.heatmap-detail-day-comments')).toBeNull()
    })
  })

  test('selecting another day updates detail panel', async () => {
    const { plugin, container } = createPlugin()
    const view = new LogView(plugin as unknown as ConstructorParameters<typeof LogView>[0], container)

    const yearlyData: HeatmapYearData = {
      year: 2025,
      days: {
        '2025-09-26': { totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
        '2025-09-25': { totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
      },
    }

    const heatmapService = (view as unknown as {
      heatmapService: {
        loadYearlyData: jest.Mock<Promise<HeatmapYearData>, [number]>
        loadDayDetail: jest.Mock<Promise<HeatmapDayDetail | null>, [string]>
      }
    }).heatmapService

    jest.spyOn(heatmapService, 'loadYearlyData').mockResolvedValue(yearlyData)
    const detailMap = new Map<string, HeatmapDayDetail>()
    detailMap.set('2025-09-26', createDetail('2025-09-26'))
    detailMap.set(
      '2025-09-25',
      createDetail('2025-09-25', {
        satisfaction: 5,
        executions: [
          {
            id: '2025-09-25-a',
            title: 'プロジェクト作業',
            taskPath: '02_Config/TaskChute/Task/プロジェクト作業.md',
            startTime: '10:00:00',
            stopTime: '12:15:00',
            durationSec: 8100,
            focusLevel: 4,
            energyLevel: 5,
            executionComment: '集中できた',
            project: 'Project X',
            projectPath: 'Project/Project X.md',
            isCompleted: true,
          },
        ],
      }),
    )

    const loadDetail = jest
      .spyOn(heatmapService, 'loadDayDetail')
      .mockImplementation(async (dateKey: string) => detailMap.get(dateKey) ?? null)

    await view.render()
    await flushMicrotasks()

    const targetCell = container.querySelector<HTMLElement>('.heatmap-cell[data-date="2025-09-25"]')
    expect(targetCell).not.toBeNull()
    targetCell?.click()
    await flushMicrotasks()

    expect(loadDetail).toHaveBeenCalledWith('2025-09-25')
    const dateEl = container.querySelector('.heatmap-detail-date')
    expect(dateEl?.textContent).toContain('2025-09-25')
    const openButton = container.querySelector('.heatmap-detail-open-button')
    expect(openButton?.textContent).toBe('↗︎ 開く')
    const heading = container.querySelector('.heatmap-detail-heading')
    expect(heading?.contains(openButton ?? null)).toBe(true)

    const detailCell = container.querySelector('.heatmap-detail-name')
    expect(detailCell?.textContent).toContain('✅')
    expect(detailCell?.textContent).toContain('プロジェクト作業')
  })

  test('calculateLevel maps completion rate into five buckets', () => {
    const { plugin, container } = createPlugin()
    const view = new LogView(plugin as unknown as ConstructorParameters<typeof LogView>[0], container)
    const calculator = view as unknown as {
      calculateLevel(stats: HeatmapDayStats): 0 | 1 | 2 | 3 | 4 | null
    }

    const makeStats = (total: number, completed: number): HeatmapDayStats => ({
      totalTasks: total,
      completedTasks: completed,
      procrastinatedTasks: Math.max(0, total - completed),
      completionRate: total > 0 ? completed / total : 0,
    })

    expect(calculator.calculateLevel(makeStats(0, 0))).toBeNull()
    expect(calculator.calculateLevel(makeStats(4, 0))).toBeNull()
    expect(calculator.calculateLevel(makeStats(4, 1))).toBe(0)
    expect(calculator.calculateLevel(makeStats(5, 2))).toBe(1)
    expect(calculator.calculateLevel(makeStats(4, 2))).toBe(2)
    expect(calculator.calculateLevel(makeStats(4, 3))).toBe(3)
    expect(calculator.calculateLevel(makeStats(20, 19))).toBe(4)
  })

  test('days with low completion but some progress render white cells', async () => {
    const { plugin, container } = createPlugin()
    const view = new LogView(plugin as unknown as ConstructorParameters<typeof LogView>[0], container)

    jest.setSystemTime(new Date('2025-10-10T09:00:00Z'))

    const yearlyData: HeatmapYearData = {
      year: 2025,
      days: {
        '2025-10-01': { totalTasks: 8, completedTasks: 0, procrastinatedTasks: 8, completionRate: 0 },
        '2025-10-02': { totalTasks: 10, completedTasks: 2, procrastinatedTasks: 8, completionRate: 0.2 },
        '2025-10-03': { totalTasks: 10, completedTasks: 5, procrastinatedTasks: 5, completionRate: 0.5 },
      },
    }

    const heatmapService = (view as unknown as {
      heatmapService: {
        loadYearlyData: jest.Mock<Promise<HeatmapYearData>, [number]>
        loadDayDetail: jest.Mock<Promise<HeatmapDayDetail | null>, [string]>
      }
    }).heatmapService

    jest.spyOn(heatmapService, 'loadYearlyData').mockResolvedValue(yearlyData)
    jest.spyOn(heatmapService, 'loadDayDetail').mockResolvedValue(createDetail('2025-10-02'))

    await view.render()
    await flushMicrotasks()

    const day1 = container.querySelector<HTMLElement>('.heatmap-cell[data-date="2025-10-01"]')
    const day2 = container.querySelector<HTMLElement>('.heatmap-cell[data-date="2025-10-02"]')
    const day3 = container.querySelector<HTMLElement>('.heatmap-cell[data-date="2025-10-03"]')

    expect(day1?.dataset.level).toBeUndefined()
    expect(day2?.dataset.level).toBe('0')
    expect(day3?.dataset.level).toBe('2')
  })
})
