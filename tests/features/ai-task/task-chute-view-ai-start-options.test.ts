/**
 * TaskChuteView.startAiRun option forwarding:
 *   - the run mode comes from settings.aiTaskRunMode (default terminal)
 *   - the originating instanceId is attached to the run
 *   - the PTY size comes from the pane controller's computeTerminalSize()
 *     and falls back to 120x30 when no pane is mounted
 *   - the pane opens on the started run
 */
import { Notice, TFile, WorkspaceLeaf } from 'obsidian'
import { TaskChuteView } from '@/features/core/views/TaskChuteView'
import type { AiRunRecord } from '@/features/ai-task/types'
import {
  AiWorkingFolderNotAllowedError,
  type AiRunStartOptions,
  type PreparedAiRun,
} from '@/features/ai-task/services/AiTaskManager'
import { AI_SKIP_PERMISSIONS_STORAGE_KEY } from '@/features/ai-task/services/AiSkipPermissionsConsent'
import {
  AI_APPROVED_FOLDERS_STORAGE_KEY,
  AI_TRUSTED_FOLDERS_STORAGE_KEY,
} from '@/features/ai-task/services/AiFolderConsent'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import type { TaskChutePluginLike, TaskInstance } from '@/types'

jest.mock('@/ui/modals/ConfirmModal', () => ({ showConfirmModal: jest.fn() }))

const TASK_PATH = 'TASKS/ai-task.md'

interface ManagerStub {
  startRun: jest.Mock<Promise<AiRunRecord>, [TFile, AiRunStartOptions?]>
  prepareRun: jest.Mock<Promise<PreparedAiRun>, [TFile, Pick<AiRunStartOptions, 'mode' | 'allowSkipPermissions'>?]>
  stopRun: jest.Mock
  getRuns: jest.Mock
  getRun: jest.Mock
  getActiveRunForTask: jest.Mock
  requestStopForTask: jest.Mock
  onChange: jest.Mock
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
}

function createManagerStub(): ManagerStub {
  return {
    startRun: jest.fn(),
    prepareRun: jest.fn(),
    stopRun: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    requestStopForTask: jest.fn(),
    onChange: jest.fn(() => jest.fn()),
    invalidateBinaryCache: jest.fn(),
    dispose: jest.fn(),
  }
}

function createPluginStub(
  settingsOverrides: Record<string, unknown> = {},
  localStorage: Map<string, unknown> = new Map(),
): TaskChutePluginLike {
  return {
    app: {
      loadLocalStorage: (key: string) => localStorage.get(key) ?? null,
      saveLocalStorage: (key: string, value: unknown) => {
        if (value === null) localStorage.delete(key)
        else localStorage.set(key, value)
      },
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
        getFiles: jest.fn(() => []),
        read: jest.fn(async () => ''),
        modify: jest.fn(),
        create: jest.fn(),
        on: jest.fn(() => ({ detach: jest.fn() })),
        adapter: {
          stat: jest.fn(async () => ({ ctime: Date.now(), mtime: Date.now() })),
          exists: jest.fn(async () => false),
          read: jest.fn(async () => '{}'),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn(() => null),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
      setting: {
        open: jest.fn(),
        openTabById: jest.fn(),
      },
      commands: {
        commands: {},
        executeCommandById: jest.fn(),
      },
    },
    settings: {
      slotKeys: {},
      useOrderBasedSort: true,
      taskFolderPath: 'TASKS',
      projectFolderPath: 'PROJECTS',
      logDataPath: 'LOGS',
      reviewDataPath: 'REVIEWS',
      aiRobotButtonEnabled: false,
      aiTaskEnabled: true,
      ...settingsOverrides,
    },
    saveSettings: jest.fn(),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn(),
      getLogYearPath: (year: string | number) => `${year}`,
      ensureYearFolder: jest.fn(async (year: string | number) => `${year}`),
      validatePath: () => ({ valid: true }),
    },
    dayStateService: {
      loadDay: jest.fn(async () => ({
        hiddenRoutines: [],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: {},
        orders: {},
      })),
      saveDay: jest.fn(async () => undefined),
      consumeLocalStateWrite: jest.fn(() => false),
    },
    routineAliasService: {
      getRouteNameFromAlias: jest.fn((name: string) => name),
      loadAliases: jest.fn().mockResolvedValue({}),
    },
    manifest: {
      id: 'taskchute-plus',
    },
    _notify: jest.fn(),
  } as unknown as TaskChutePluginLike
}

function makeTaskFile(path = TASK_PATH, basename = 'ai-task'): TFile {
  const file = new TFile()
  file.path = path
  file.basename = basename
  file.extension = 'md'
  return file
}

function makeInstance(instanceId = 'inst-1'): TaskInstance {
  const file = makeTaskFile()
  return {
    task: {
      file,
      frontmatter: { ai_task: true },
      path: file.path,
      name: 'ai-task',
    },
    instanceId,
    state: 'idle',
    slotKey: 'none',
  }
}

function makeRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'ai-run-1',
    taskPath: TASK_PATH,
    taskName: 'ai-task',
    host: 'claude',
    mode: 'terminal',
    status: 'running',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

interface ViewInternals {
  startAiRun(inst: TaskInstance): Promise<void>
  prepareAiRunForInstance(
    inst: TaskInstance,
    manager: unknown,
    trigger: 'manual' | 'automatic',
  ): Promise<{ kind: string }>
  startInstance(inst: TaskInstance): Promise<void>
  startAmbientAiInstance(inst: TaskInstance, manager: unknown): Promise<unknown>
  startLinkedAiTask(inst: TaskInstance): Promise<unknown>
  aiRunPaneController: unknown
}

function setUp(
  settingsOverrides: Record<string, unknown> = {},
  localStorage: Map<string, unknown> = new Map(),
): {
  manager: ManagerStub
  view: TaskChuteView
  internals: ViewInternals
} {
  const plugin = createPluginStub(settingsOverrides, localStorage)
  const manager = createManagerStub()
  ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  view.renderTaskList = jest.fn()
  return { manager, view, internals: view as unknown as ViewInternals }
}

describe('TaskChuteView startAiRun option forwarding', () => {
  test('passes terminal mode, the originating instanceId, and the 120x30 fallback size', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockResolvedValueOnce(makeRecord({ instanceId: 'inst-7' }))

    await internals.startAiRun(makeInstance('inst-7'))

    expect(manager.startRun).toHaveBeenCalledTimes(1)
    const [file, options] = manager.startRun.mock.calls[0]
    expect(file.path).toBe(TASK_PATH)
    expect(options).toEqual({
      mode: 'terminal',
      allowSkipPermissions: false,
      instanceId: 'inst-7',
      cols: 120,
      rows: 30,
    })
  })

  test('passes headless mode when the setting says so', async () => {
    const { manager, internals } = setUp({ aiTaskRunMode: 'headless' })
    manager.startRun.mockResolvedValueOnce(makeRecord({ mode: 'headless' }))

    await internals.startAiRun(makeInstance())

    const options = manager.startRun.mock.calls[0][1]
    expect(options?.mode).toBe('headless')
  })

  test('uses the pane controller size when the pane is mounted', async () => {
    const { manager, view, internals } = setUp()
    const openRun = jest.fn()
    ;(view as unknown as { aiRunPaneController: unknown }).aiRunPaneController = {
      computeTerminalSize: () => ({ cols: 96, rows: 20 }),
      openRun,
    }
    manager.startRun.mockResolvedValueOnce(makeRecord())

    await internals.startAiRun(makeInstance())

    const options = manager.startRun.mock.calls[0][1]
    expect(options?.cols).toBe(96)
    expect(options?.rows).toBe(20)
    expect(openRun).toHaveBeenCalledWith('ai-run-1')
  })
})

// LEV-386: a note only asks for skip-permissions; this device decides. The
// user is asked once when they start such a task; an automatic start cannot
// ask, so it runs in auto mode and says so.
describe('TaskChuteView skip-permissions consent', () => {
  const confirm = showConfirmModal as jest.Mock
  const NoticeMock = Notice as unknown as jest.Mock

  function skipInstance(args = '--dangerously-skip-permissions'): TaskInstance {
    const inst = makeInstance()
    inst.task.frontmatter = { ai_task: true, ai_task_args: args }
    return inst
  }

  function prepared(overrides: Partial<PreparedAiRun> = {}): PreparedAiRun {
    return {
      taskPath: TASK_PATH,
      taskName: 'ai-task',
      host: 'claude',
      mode: 'terminal',
      prompt: '',
      extraArgs: [],
      binaryPath: '/bin/claude',
      recipeSnapshot: null,
      ...overrides,
    }
  }

  const noticeTexts = (): string[] =>
    NoticeMock.mock.calls.map(([text]) => String(text))

  beforeEach(() => {
    confirm.mockReset()
    NoticeMock.mockClear()
  })

  test('a manual start asks once, and this device keeps the yes', async () => {
    const storage = new Map<string, unknown>()
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockImplementation((_file, options) =>
      Promise.resolve(prepared({ skipPermissionsDowngraded: options?.allowSkipPermissions !== true })),
    )
    confirm.mockResolvedValue(true)

    const first = await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')
    await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')

    expect(first).toEqual({
      kind: 'ready',
      prepared: expect.objectContaining({ skipPermissionsDowngraded: false }),
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    // Prepared as this device allowed, asked, prepared again; then allowed.
    expect(manager.prepareRun.mock.calls.map(([, options]) => options?.allowSkipPermissions))
      .toEqual([false, true, true])
    expect(storage.get(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(true)
  })

  test('answering auto mode runs without it this time, and asks again next time', async () => {
    const storage = new Map<string, unknown>()
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(prepared({ skipPermissionsDowngraded: true }))
    confirm.mockResolvedValue(false)

    await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')
    await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')

    expect(confirm).toHaveBeenCalledTimes(2)
    expect(manager.prepareRun.mock.calls.map(([, options]) => options?.allowSkipPermissions))
      .toEqual([false, false])
    expect(storage.has(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(false)
    // The user chose auto mode; nothing to report.
    expect(noticeTexts().some((text) => text.includes('skip permissions'))).toBe(false)
  })

  test('an automatic start never asks: it runs in auto mode and says so', async () => {
    const { manager, internals } = setUp()
    manager.prepareRun.mockResolvedValue(prepared({ skipPermissionsDowngraded: true }))

    const result = await internals.prepareAiRunForInstance(skipInstance(), manager, 'automatic')

    expect(result.kind).toBe('ready')
    expect(confirm).not.toHaveBeenCalled()
    expect(manager.prepareRun.mock.calls[0][1]?.allowSkipPermissions).toBe(false)
    expect(noticeTexts()).toContainEqual(expect.stringContaining('runs in auto mode'))
  })

  test('a device that allowed it never asks, for manual or automatic starts', async () => {
    const storage = new Map<string, unknown>([[AI_SKIP_PERMISSIONS_STORAGE_KEY, true]])
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(prepared())

    await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')
    await internals.prepareAiRunForInstance(skipInstance(), manager, 'automatic')

    expect(confirm).not.toHaveBeenCalled()
    expect(manager.prepareRun.mock.calls.map(([, options]) => options?.allowSkipPermissions))
      .toEqual([true, true])
  })

  test('the working folder is asked about first; Cancel there asks nothing more', async () => {
    const storage = new Map<string, unknown>()
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(
      prepared({
        cwd: '/Users/me',
        cwdIsVault: false,
        skipPermissionsDowngraded: true,
        ignoredArgs: ['--mcp-config', 'evil.json'],
      }),
    )
    confirm.mockResolvedValue(false)

    const result = await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')

    expect(result.kind).toBe('failed')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][1]).toEqual(
      expect.objectContaining({ confirmText: 'Allow this folder' }),
    )
    // Nothing allowed for the device, and nothing said about a run that did not start.
    expect(storage.has(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(false)
    expect(noticeTexts()).toEqual([])
  })

  test('folder allowed, then skip-permissions asked, then the run is prepared with it', async () => {
    const storage = new Map<string, unknown>()
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockImplementation((_file, options) =>
      Promise.resolve(
        prepared({
          cwd: '/Users/me',
          cwdIsVault: false,
          skipPermissionsDowngraded: options?.allowSkipPermissions !== true,
        }),
      ),
    )
    confirm.mockResolvedValue(true)

    const result = await internals.prepareAiRunForInstance(skipInstance(), manager, 'manual')

    expect(result.kind).toBe('ready')
    expect(confirm.mock.calls.map(([, options]) => (options as { confirmText: string }).confirmText))
      .toEqual(['Allow this folder', 'Allow on this device'])
    expect(manager.prepareRun.mock.calls.map(([, options]) => options?.allowSkipPermissions))
      .toEqual([false, true])
    expect(storage.get(AI_APPROVED_FOLDERS_STORAGE_KEY)).toEqual(['/Users/me'])
    expect(storage.get(AI_SKIP_PERMISSIONS_STORAGE_KEY)).toBe(true)
  })

  test('a task that does not ask for skip-permissions is never asked about', async () => {
    const { manager, internals } = setUp()
    manager.prepareRun.mockResolvedValue(prepared())

    await internals.prepareAiRunForInstance(skipInstance('--model opus'), manager, 'manual')

    expect(confirm).not.toHaveBeenCalled()
    expect(manager.prepareRun.mock.calls[0][1]?.allowSkipPermissions).toBe(false)
  })

  test('note arguments the run left out are reported', async () => {
    const { manager, internals } = setUp()
    manager.prepareRun.mockResolvedValue(
      prepared({ ignoredArgs: ['--mcp-config', 'evil.json'] }),
    )

    await internals.prepareAiRunForInstance(skipInstance('--model opus'), manager, 'manual')

    expect(noticeTexts()).toContainEqual(expect.stringContaining('--mcp-config evil.json'))
  })
})

// LEV-386: only ▶ is a manual start; the schedule and the link are not, so
// they never ask and never count as the user's consent.
describe('TaskChuteView AI start triggers', () => {
  test('▶ starts are manual; scheduled and linked starts are automatic', async () => {
    const { manager, internals } = setUp()
    const triggers: string[] = []
    internals.prepareAiRunForInstance = jest.fn(async (_inst, _manager, trigger) => {
      triggers.push(trigger)
      return { kind: 'failed' }
    })

    await internals.startInstance(makeInstance('manual'))
    await internals.startAmbientAiInstance(makeInstance('ambient'), manager)
    await internals.startLinkedAiTask(makeInstance('linked'))

    expect(triggers).toEqual(['manual', 'automatic', 'automatic'])
  })
})

// LEV-390: a working folder (or "trust this folder") this device has not
// approved is asked about on ▶, and holds an automatic start.
describe('TaskChuteView working-folder consent', () => {
  const confirm = showConfirmModal as jest.Mock
  const NoticeMock = Notice as unknown as jest.Mock

  function prepared(overrides: Partial<PreparedAiRun> = {}): PreparedAiRun {
    return {
      taskPath: TASK_PATH,
      taskName: 'ai-task',
      host: 'claude',
      mode: 'terminal',
      prompt: '',
      cwd: '/Users/me',
      cwdIsVault: false,
      extraArgs: [],
      binaryPath: '/bin/claude',
      recipeSnapshot: null,
      ...overrides,
    }
  }
  const folderNotices = (): string[] =>
    NoticeMock.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('/Users/me'))

  beforeEach(() => {
    confirm.mockReset()
    NoticeMock.mockClear()
  })

  test('▶ asks, and an allowed folder is kept on this device', async () => {
    const storage = new Map<string, unknown>()
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(prepared())
    confirm.mockResolvedValue(true)

    const first = await internals.prepareAiRunForInstance(makeInstance(), manager, 'manual')
    const second = await internals.prepareAiRunForInstance(makeInstance(), manager, 'manual')

    expect([first.kind, second.kind]).toEqual(['ready', 'ready'])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][1]).toEqual(
      expect.objectContaining({ message: '/Users/me', confirmText: 'Allow this folder' }),
    )
    expect(storage.get(AI_APPROVED_FOLDERS_STORAGE_KEY)).toEqual(['/Users/me'])
  })

  test('▶ and Cancel: the task does not start', async () => {
    const storage = new Map<string, unknown>()
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(prepared({ trustFolder: true }))
    confirm.mockResolvedValue(false)

    const result = await internals.prepareAiRunForInstance(makeInstance(), manager, 'manual')

    expect(result.kind).toBe('failed')
    expect(String(confirm.mock.calls[0][1].message)).toContain('trusts this folder')
    expect(storage.has(AI_APPROVED_FOLDERS_STORAGE_KEY)).toBe(false)
  })

  test('an automatic start does not ask and does not start, and says so once', async () => {
    const { manager, internals } = setUp()
    manager.prepareRun.mockResolvedValue(prepared())

    const first = await internals.prepareAiRunForInstance(makeInstance(), manager, 'automatic')
    const again = await internals.prepareAiRunForInstance(makeInstance(), manager, 'automatic')

    expect([first.kind, again.kind]).toEqual(['failed', 'failed'])
    expect(confirm).not.toHaveBeenCalled()
    expect(folderNotices()).toHaveLength(1)
    expect(folderNotices()[0]).toContain('did not start automatically')
  })

  test('the vault, and folders allowed on this device, need nothing', async () => {
    const storage = new Map<string, unknown>([[AI_APPROVED_FOLDERS_STORAGE_KEY, ['/Users/me']]])
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValueOnce(prepared({ cwd: '/vault', cwdIsVault: true }))
    manager.prepareRun.mockResolvedValueOnce(prepared())

    const vault = await internals.prepareAiRunForInstance(makeInstance(), manager, 'automatic')
    const allowed = await internals.prepareAiRunForInstance(makeInstance(), manager, 'automatic')

    expect([vault.kind, allowed.kind]).toEqual(['ready', 'ready'])
    expect(confirm).not.toHaveBeenCalled()
  })

  test('a folder only in the recent-folders history is still asked about', async () => {
    const storage = new Map<string, unknown>([
      ['taskchute-plus.ai-task-working-directory-history', ['/Users/me/listed']],
    ])
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(prepared({ cwd: '/Users/me/listed' }))
    confirm.mockResolvedValue(false)

    const result = await internals.prepareAiRunForInstance(makeInstance(), manager, 'manual')

    expect(result.kind).toBe('failed')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  test('trusting a folder allowed only to run in is asked about, and kept as trusted', async () => {
    const storage = new Map<string, unknown>([[AI_APPROVED_FOLDERS_STORAGE_KEY, ['/srv/repo']]])
    const { manager, internals } = setUp({}, storage)
    manager.prepareRun.mockResolvedValue(prepared({ cwd: '/srv/repo', trustFolder: true }))
    confirm.mockResolvedValue(true)

    const result = await internals.prepareAiRunForInstance(makeInstance(), manager, 'manual')

    expect(result.kind).toBe('ready')
    expect(String(confirm.mock.calls[0][1].message)).toContain('trusts this folder')
    expect(storage.get(AI_TRUSTED_FOLDERS_STORAGE_KEY)).toEqual(['/srv/repo'])
  })

  test('the dialog shows the folder without control characters', async () => {
    const { manager, internals } = setUp()
    manager.prepareRun.mockResolvedValue(prepared({ cwd: '/srv/a\u202Etxt.exe' }))
    confirm.mockResolvedValue(false)

    await internals.prepareAiRunForInstance(makeInstance(), manager, 'manual')

    expect(confirm.mock.calls[0][1]).toEqual(
      expect.objectContaining({ message: '/srv/a\uFFFDtxt.exe' }),
    )
  })

  test('a run the manager refuses for its folder says why', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockRejectedValue(
      new AiWorkingFolderNotAllowedError({ taskPath: TASK_PATH, taskName: 'ai-task' }, '/Users/me/x', false),
    )

    await internals.startAiRun(makeInstance())

    expect(folderNotices()).toEqual([
      '"ai-task" did not start: its working folder /Users/me/x is not allowed on this device. Start the task with ▶ to be asked.',
    ])
  })

  test('trusting the vault still needs this device to allow it', async () => {
    const { manager, internals } = setUp()
    manager.prepareRun.mockResolvedValue(prepared({ cwd: '/vault', cwdIsVault: true, trustFolder: true }))

    const result = await internals.prepareAiRunForInstance(makeInstance(), manager, 'automatic')

    expect(result.kind).toBe('failed')
  })
})
