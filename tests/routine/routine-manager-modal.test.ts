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
  }) => {
    const frontmatterStore = new Map<string, Record<string, unknown>>()
    const file = createFile('TASKS/routine.md')
    frontmatterStore.set(file.path, {
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

  beforeEach(() => {
    NoticeMock.mockClear()
  })

  it('uses current view date as target_date when disabling routine', async () => {
    const { modal, file, frontmatterStore } = createModal({
      currentDate: new Date(2025, 10, 30),
    })

    const updateRoutineEnabled = (modal as unknown as {
      updateRoutineEnabled: (target: TFile, enabled: boolean) => Promise<void>
    }).updateRoutineEnabled

    await updateRoutineEnabled.call(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBe('2025-11-30')
  })

  it('uses active taskchute view date when multiple taskchute leaves are open', async () => {
    const { modal, file, frontmatterStore } = createModal({
      viewDates: [new Date(2025, 10, 30), new Date(2025, 11, 1)],
      activeLeafIndex: 1,
    })

    const updateRoutineEnabled = (modal as unknown as {
      updateRoutineEnabled: (target: TFile, enabled: boolean) => Promise<void>
    }).updateRoutineEnabled

    await updateRoutineEnabled.call(modal, file, false)

    const fm = frontmatterStore.get(file.path)
    expect(fm?.routine_enabled).toBe(false)
    expect(fm?.target_date).toBe('2025-12-01')
  })
})
