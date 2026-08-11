import { App, Notice, TFile, WorkspaceLeaf } from 'obsidian'
import RoutineManagerModal from '../../src/features/routine/modals/RoutineManagerModal'
import type { TaskChutePluginLike } from '../../src/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

const NoticeMock = Notice as unknown as jest.Mock

describe('RoutineManagerModal', () => {
  const createFile = (path: string): TFile => {
    const file = new TFile()
    file.path = path
    file.basename = path.split('/').pop() ?? path
    file.extension = 'md'
    return file
  }

  const createModal = (options?: {
    currentDate?: Date
    viewDates?: Date[]
    activeLeafIndex?: number
    frontmatter?: Record<string, unknown>
  }) => {
    const frontmatterStore = new Map<string, Record<string, unknown>>()
    const file = createFile('TASKS/routine.md')
    frontmatterStore.set(file.path, options?.frontmatter ?? {
      isRoutine: true,
      routine_enabled: true,
      routine_type: 'daily',
      routine_interval: 1,
    })

    const processFrontMatter = jest.fn(
      async (target: TFile, updater: (fm: Record<string, unknown>) => Record<string, unknown>) => {
        const existing = { ...(frontmatterStore.get(target.path) ?? {}) }
        const updated = updater(existing)
        frontmatterStore.set(target.path, updated)
      },
    )

    const viewDates = options?.viewDates ?? [options?.currentDate ?? new Date(2025, 10, 30)]
    const leaves = viewDates.map(
      (currentDate) =>
        ({
          view: {
            currentDate,
          },
        }) as unknown as WorkspaceLeaf,
    )
    const activeLeaf = leaves[options?.activeLeafIndex ?? 0] ?? leaves[0]

    const app = {
      fileManager: {
        processFrontMatter,
      },
      workspace: {
        getLeavesOfType: jest.fn(() => leaves),
        getMostRecentLeaf: jest.fn(() => activeLeaf),
      },
    }

    const plugin = {
      pathManager: {
        getTaskFolderPath: () => 'TASKS',
      },
    } as unknown as TaskChutePluginLike

    const modal = new RoutineManagerModal(app as unknown as App, plugin)
    return { modal, file, frontmatterStore, processFrontMatter }
  }

  const callUpdateRoutineEnabled = async (
    modal: RoutineManagerModal,
    file: TFile,
    enabled: boolean,
  ) => {
    const fn = (modal as unknown as {
      updateRoutineEnabled: (target: TFile, enabled: boolean) => Promise<void>
    }).updateRoutineEnabled
    await fn.call(modal, file, enabled)
  }

  beforeEach(() => {
    NoticeMock.mockClear()
  })

  it('uses current view date as target_date when disabling routine', async () => {
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2025, 10, 30),
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBe('2025-11-30')
  })

  it('uses active taskchute view date when multiple taskchute leaves are open', async () => {
    const { modal, file, frontmatterStore } = createModal({
      viewDates: [new Date(2025, 10, 30), new Date(2025, 11, 1)],
      activeLeafIndex: 1,
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBe('2025-12-01')
  })

  it('does not set target_date when routine_end is in the past', async () => {
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2026, 2, 5), // 2026-03-05
      frontmatter: {
        isRoutine: true,
        routine_enabled: true,
        routine_type: 'daily',
        routine_interval: 1,
        routine_end: '2026-01-18',
      },
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBeUndefined()
  })

  it('does not set target_date when routine_start is in the future', async () => {
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2026, 2, 5), // 2026-03-05
      frontmatter: {
        isRoutine: true,
        routine_enabled: true,
        routine_type: 'daily',
        routine_interval: 1,
        routine_start: '2026-04-01',
      },
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBeUndefined()
  })

  it('does not set target_date for weekly routine when today is not a due day', async () => {
    // 2026-03-05 is Thursday (weekday 4)
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2026, 2, 5),
      frontmatter: {
        isRoutine: true,
        routine_enabled: true,
        routine_type: 'weekly',
        routine_interval: 1,
        routine_weekday: 1, // Monday
        routine_start: '2026-01-05',
      },
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBeUndefined()
    expect(fm?.routine_disabled_without_target_date).toBe(true)
  })

  it('does not set target_date for interval=2 daily routine when today is not a due day', async () => {
    // routine_start: 2026-03-04, interval: 2 → due on 03-04, 03-06, etc.
    // viewDate: 2026-03-05 → not due
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2026, 2, 5), // 2026-03-05
      frontmatter: {
        isRoutine: true,
        routine_enabled: true,
        routine_type: 'daily',
        routine_interval: 2,
        routine_start: '2026-03-04',
      },
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBeUndefined()
    expect(fm?.routine_disabled_without_target_date).toBe(true)
  })

  it('sets target_date when daily routine is due on the view date', async () => {
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2026, 2, 5),
      frontmatter: {
        isRoutine: true,
        routine_enabled: true,
        routine_type: 'daily',
        routine_interval: 1,
      },
    })

    await callUpdateRoutineEnabled(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBe('2026-03-05')
  })

  it('deletes target_date when re-enabling routine', async () => {
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2026, 2, 5),
      frontmatter: {
        isRoutine: true,
        routine_enabled: false,
        routine_type: 'daily',
        routine_interval: 1,
        target_date: '2026-03-01',
      },
    })

    await callUpdateRoutineEnabled(modal, file, true)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(true)
    expect(fm?.target_date).toBeUndefined()
  })
})
