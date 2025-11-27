import { initializeLocaleManager } from '../../src/i18n'
import { LogView } from '../../src/features/log/views/LogView'
import type { HeatmapDayDetail, HeatmapDayStats, HeatmapYearData } from '../../src/types'

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

const ensureObsidianDomHelpers = () => {
  type ObsidianPrototype = typeof HTMLElement.prototype & {
    empty?: () => void
    createEl?: (
      this: HTMLElement,
      tag: string,
      options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> },
    ) => HTMLElement
    setAttr?: (this: HTMLElement, name: string, value: string) => void
  }

  const proto = HTMLElement.prototype as ObsidianPrototype
  if (!proto.empty) {
    proto.empty = function (this: HTMLElement) {
      this.textContent = ''
      this.innerHTML = ''
    }
  }
  if (!proto.createEl) {
    proto.createEl = function (
      this: HTMLElement,
      tag: string,
      options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> },
    ) {
      const el = document.createElement(tag)
      if (options?.cls) {
        if (Array.isArray(options.cls)) {
          el.className = options.cls.join(' ')
        } else {
          el.className = options.cls
        }
      }
      if (options?.text) {
        el.textContent = options.text
      }
      if (options?.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          el.setAttribute(key, value)
        })
      }
      this.appendChild(el)
      return el
    }
  }
  if (!proto.setAttr) {
    proto.setAttr = function (this: HTMLElement, name: string, value: string) {
      this.setAttribute(name, value)
    }
  }
}

describe('LogView heatmap detail panel', () => {
  let rafSpy: jest.SpyInstance<number, [FrameRequestCallback]> | null = null

beforeAll(() => {
  initializeLocaleManager('ja')
  ensureObsidianDomHelpers()
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
    const view = new LogView(plugin, container)

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

    const satisfactionEl = container.querySelector('.heatmap-detail-satisfaction')
    expect(satisfactionEl?.textContent).toBe('1日の満足度: 4/5')

    const rows = container.querySelectorAll('.heatmap-detail-table tbody tr')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('朝のルーティン')
  })

  test('selecting another day updates detail and open button navigates', async () => {
    const { plugin, container } = createPlugin()
    const view = new LogView(plugin, container)

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
    const satisfactionEl = container.querySelector('.heatmap-detail-satisfaction')
    expect(satisfactionEl?.textContent).toBe('1日の満足度: 5/5')

    const detailCell = container.querySelector('.heatmap-detail-name')
    expect(detailCell?.textContent).toContain('✅')
    expect(detailCell?.textContent).toContain('プロジェクト作業')

    const navigableView = view as unknown as {
      navigateToDate: (dateKey: string) => Promise<void>
    }
    const navigateSpy = jest
      .spyOn(navigableView, 'navigateToDate')
      .mockResolvedValue(undefined)
    const openButton = container.querySelector<HTMLButtonElement>('.heatmap-detail-open-button')
    openButton?.click()
    await flushMicrotasks()

    expect(navigateSpy).toHaveBeenCalledWith('2025-09-25')
  })

  test('calculateLevel maps completion rate into five buckets', () => {
    const { plugin, container } = createPlugin()
    const view = new LogView(plugin, container)
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
    const view = new LogView(plugin, container)

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
