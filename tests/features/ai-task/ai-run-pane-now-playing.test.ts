/**
 * AiRunPaneController NOW PLAYING layout (U1):
 *   - LEFT vertical sidebar with one row per run (status dot + truncated
 *     task name + small × control); clicking a row selects the run
 *   - RIGHT content area with a slim tab strip showing ONE tab for the
 *     selected run (status dot + content label + × control) and top-right
 *     corner actions (expand toggle; extension point for the U2 split)
 *   - × semantics: on an ACTIVE run it requests stop AND closes the view,
 *     but only after the manager's 'persisted' notification (the exit-time
 *     terminal snapshot must be consumed from a live adapter first); on an
 *     already-finished run it closes immediately
 *   - ⤢ expand toggle: near-full-height pane via .is-expanded (and the
 *     container chrome class), persisted per device through the host's
 *     App#saveLocalStorage bridge and restored on mount
 */
import { TFile } from 'obsidian'
import {
  AiRunPaneController,
  AI_PANE_EXPANDED_STORAGE_KEY,
  AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY,
} from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import {
  AiTaskManager,
  type AiRunChangeType,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type {
  AiTerminalDispatcher,
  TerminalRunCallbacks,
  TerminalRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type {
  AiDispatcher,
  AiRunExitOutcome,
} from '../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type { TerminalViewAdapterLike } from '../../../src/features/ai-task/ui/TerminalViewAdapter'
import type {
  FileEditorAdapterLike,
  FileEditorOpenOptions,
} from '../../../src/features/ai-task/ui/FileEditorAdapter'
import type { AiRunRecord } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord, changeType?: AiRunChangeType) => void
type TerminalDataListener = (chunk: string) => void

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeTerminalAdapter implements TerminalViewAdapterLike {
  opened: { container: HTMLElement; cols: number; rows: number } | null = null
  written: string[] = []
  focus = jest.fn()
  fit = jest.fn()
  disposed = false
  snapshot = 'fake terminal snapshot'
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly resizeListeners = new Set<
    (size: { cols: number; rows: number }) => void
  >()
  private readonly filePathListeners = new Set<
    (target: { path: string; line?: number; column?: number }) => void
  >()

  open(container: HTMLElement, cols: number, rows: number): void {
    this.opened = { container, cols, rows }
  }

  write(data: string): void {
    this.written.push(data)
  }

  snapshotText(): string {
    return this.disposed ? '' : this.snapshot
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback)
    return () => {
      this.dataListeners.delete(callback)
    }
  }

  onResize(callback: (size: { cols: number; rows: number }) => void): () => void {
    this.resizeListeners.add(callback)
    return () => {
      this.resizeListeners.delete(callback)
    }
  }

  emitResize(cols: number, rows: number): void {
    for (const listener of Array.from(this.resizeListeners)) {
      listener({ cols, rows })
    }
  }

  onFilePathActivate(
    callback: (target: { path: string; line?: number; column?: number }) => void,
  ): () => void {
    this.filePathListeners.add(callback)
    return () => this.filePathListeners.delete(callback)
  }

  emitFilePath(path: string, line?: number, column?: number): void {
    for (const listener of Array.from(this.filePathListeners)) {
      listener({ path, line, column })
    }
  }

  dispose(): void {
    this.disposed = true
    this.dataListeners.clear()
    this.resizeListeners.clear()
    this.filePathListeners.clear()
  }
}

class FakeFileEditorAdapter implements FileEditorAdapterLike {
  document = ''
  languagePath: string | null = null
  editable = false
  disposed = false
  private onChange: ((document: string) => void) | null = null
  private onSave: (() => void) | null = null

  open(_container: HTMLElement, options: FileEditorOpenOptions): void {
    this.document = options.document
    this.editable = options.editable
    this.onChange = options.onChange
    this.onSave = options.onSave
  }

  setDocument(document: string): void {
    this.document = document
  }

  setLanguagePath(path: string | null): void {
    this.languagePath = path
  }

  setEditable(editable: boolean): void {
    this.editable = editable
  }

  getDocument(): string {
    return this.document
  }

  focus(): void {}

  dispose(): void {
    this.disposed = true
  }

  type(document: string): void {
    this.document = document
    this.onChange?.(document)
  }

  saveShortcut(): void {
    this.onSave?.()
  }
}

class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly records: AiRunRecord[] = []
  readonly terminalListeners = new Map<string, Set<TerminalDataListener>>()
  readonly stopRun = jest.fn()
  readonly followUp = jest.fn(() => Promise.resolve())
  readonly sendTerminalInput = jest.fn()
  readonly resizeTerminal = jest.fn()
  readonly readWorkspaceFile = jest.fn(async (rootPath: string, filePath: string) => ({
    rootPath,
    relativePath: filePath.replace(`${rootPath}/`, ''),
    absolutePath: filePath.startsWith('/') ? filePath : `${rootPath}/${filePath}`,
    content: '---\ntitle: Hidden\n---\nOriginal body\n',
    version: { mtimeMs: 10, size: 43 },
  }))
  readonly writeWorkspaceFile = jest.fn(
    async (rootPath: string, filePath: string, content: string) => ({
      rootPath,
      relativePath: filePath.replace(`${rootPath}/`, ''),
      absolutePath: filePath,
      content,
      version: { mtimeMs: 20, size: content.length },
    }),
  )
  failNextWorkspaceDirectory = false
  failNextWorkspaceRoot = false
  readonly listWorkspaceDirectory = jest.fn(
    async (_rootPath: string, directoryPath = '/workspace/project') => {
      if (
        this.failNextWorkspaceRoot &&
        directoryPath === '/workspace/project'
      ) {
        this.failNextWorkspaceRoot = false
        throw new Error('temporary root read failure')
      }
      if (this.failNextWorkspaceDirectory && directoryPath.endsWith('src')) {
        this.failNextWorkspaceDirectory = false
        throw new Error('temporary read failure')
      }
      return {
        rootPath: '/workspace/project',
        directoryPath:
          directoryPath === '/workspace/project' ? '' : 'src',
        entries: directoryPath.endsWith('src')
          ? [
            {
              name: 'main.ts',
              absolutePath: '/workspace/project/src/main.ts',
              relativePath: 'src/main.ts',
              type: 'file' as const,
            },
          ]
        : [
            {
              name: 'src',
              absolutePath: '/workspace/project/src',
              relativePath: 'src',
              type: 'folder' as const,
            },
            {
              name: "read'me.md",
              absolutePath: "/workspace/project/read'me.md",
              relativePath: "read'me.md",
              type: 'file' as const,
            },
            ],
      }
    },
  )
  snapshotProvider:
    | ((runId: string) => string | undefined | Promise<string | undefined>)
    | null = null

  registerTerminalSnapshotProvider(
    provider: (
      runId: string,
    ) => string | undefined | Promise<string | undefined>,
  ): () => void {
    this.snapshotProvider = provider
    return () => {
      if (this.snapshotProvider === provider) {
        this.snapshotProvider = null
      }
    }
  }

  getRuns(): AiRunRecord[] {
    return [...this.records]
  }

  getRun(runId: string): AiRunRecord | undefined {
    return this.records.find((record) => record.id === runId)
  }

  getActiveRunForTask(taskPath: string): AiRunRecord | undefined {
    return this.records.find(
      (record) =>
        record.taskPath === taskPath &&
        (record.status === 'starting' ||
          record.status === 'running' ||
          record.status === 'stopping'),
    )
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onTerminalData(runId: string, listener: TerminalDataListener): () => void {
    const listeners = this.terminalListeners.get(runId) ?? new Set()
    this.terminalListeners.set(runId, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  emit(record: AiRunRecord, changeType: AiRunChangeType = 'update'): void {
    if (!this.records.includes(record)) {
      this.records.push(record)
    }
    for (const listener of Array.from(this.listeners)) {
      listener(record, changeType)
    }
  }
}

function createRun(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run-1',
    taskPath: 'TASKS/ai-sample.md',
    taskName: 'AI sample',
    host: 'claude',
    mode: 'terminal',
    status: 'running',
    cols: 100,
    rows: 25,
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

describe('AiRunPaneController NOW PLAYING layout', () => {
  let container: HTMLElement
  let manager: FakeManager
  let adapters: FakeTerminalAdapter[]
  let fileEditors: FakeFileEditorAdapter[]
  let saveLocalStorage: jest.Mock
  let loadLocalStorage: jest.Mock
  let onStopAndCloseTaskRun: jest.Mock
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController

  const pane = (): HTMLElement | null => container.querySelector('.ai-run-pane')
  const rows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__run'))
  const bodies = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.ai-run-pane__body'))

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    manager = new FakeManager()
    adapters = []
    fileEditors = []
    saveLocalStorage = jest.fn()
    loadLocalStorage = jest.fn(() => null)
    onStopAndCloseTaskRun = jest.fn()
    host = {
      tv: (_key, fallback, vars) => {
        if (!vars) return fallback
        return Object.entries(vars).reduce(
          (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
          fallback,
        )
      },
      manager,
      createTerminalAdapter: () => {
        const adapter = new FakeTerminalAdapter()
        adapters.push(adapter)
        return adapter
      },
      createFileEditorAdapter: () => {
        const editor = new FakeFileEditorAdapter()
        fileEditors.push(editor)
        return editor
      },
      registerManagedDisposer: () => undefined,
      onStopAndCloseTaskRun,
      saveLocalStorage,
      loadLocalStorage,
    }
    controller = new AiRunPaneController(host)
  })

  describe('vertical sidebar + content area', () => {
    test('renders one sidebar row per run with the status dot and truncated name', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(
        createRun({ id: 'run-b', taskName: 'Task B', status: 'succeeded' }),
      )

      const sidebar = container.querySelector('.ai-run-pane__sidebar')
      expect(sidebar).not.toBeNull()
      expect(rows()).toHaveLength(2)

      const rowA = container.querySelector(
        '.ai-run-pane__run[data-run-id="run-a"]',
      )
      expect(rowA?.querySelector('.ai-run-pane__run-dot--running')).not.toBeNull()
      expect(
        rowA?.querySelector('.ai-run-pane__run-name')?.textContent,
      ).toBe('Task A')

      const rowB = container.querySelector(
        '.ai-run-pane__run[data-run-id="run-b"]',
      )
      expect(rowB?.querySelector('.ai-run-pane__run-dot--succeeded')).not.toBeNull()
    })

    test('clicking a sidebar row selects the run and switches the visible body', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(createRun({ id: 'run-b', taskName: 'Task B' }))

      // run-a was auto-selected as the first run.
      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(true)

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()

      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-b"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
      expect(
        container
          .querySelector('.ai-run-pane__body[data-run-id="run-b"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
      expect(
        container
          .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(false)
    })

    test('vertical run tabs use roving focus and APG arrow navigation', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a', taskName: 'Task A' }))
      manager.emit(createRun({ id: 'run-b', taskName: 'Task B' }))

      const tablist = container.querySelector<HTMLElement>(
        '.ai-run-pane__sidebar-runs',
      )
      const row = (runId: string): HTMLElement | null =>
        container.querySelector(
          `.ai-run-pane__run[data-run-id="${runId}"]`,
        )
      expect(tablist?.getAttribute('role')).toBe('tablist')
      expect(tablist?.getAttribute('aria-orientation')).toBe('vertical')
      expect(row('run-a')?.getAttribute('tabindex')).toBe('0')
      expect(row('run-b')?.getAttribute('tabindex')).toBe('-1')
      expect(row('run-a')?.getAttribute('aria-controls')).toBe(
        'ai-run-body-run-a',
      )
      expect(
        container
          .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
          ?.getAttribute('role'),
      ).toBe('tabpanel')

      row('run-a')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
      expect(row('run-b')?.classList.contains('is-active')).toBe(true)
      expect(row('run-a')?.getAttribute('tabindex')).toBe('-1')
      expect(row('run-b')?.getAttribute('tabindex')).toBe('0')
      expect(document.activeElement).toBe(row('run-b'))

      row('run-b')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      )
      expect(row('run-a')?.classList.contains('is-active')).toBe(true)
      expect(document.activeElement).toBe(row('run-a'))
    })

    test('multiple AI runs share one replaceable task tab until + or split is explicit', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-a' }))
      manager.emit(createRun({ id: 'run-b', mode: 'headless' }))

      const strip = container.querySelector('.ai-run-pane__tabstrip')
      expect(strip).not.toBeNull()
      expect(strip?.classList).toContain('ai-run-pane__work-tabbar')
      let tabs = container.querySelectorAll('.ai-run-pane__tab')
      expect(tabs).toHaveLength(1)
      expect(tabs[0].classList).toContain('ai-run-pane__work-tab')
      expect(tabs[0].querySelector('.ai-run-pane__work-tab-close')).not.toBeNull()
      expect(tabs[0].getAttribute('data-run-id')).toBe('run-a')
      // The status dot is a CSS circle, not a '●' glyph: presence of the
      // status-modifier class is what marks the run as running.
      expect(
        tabs[0].querySelector('.ai-run-pane__tab-dot--running'),
      ).not.toBeNull()
      // Terminal runs read "Terminal"; the label is the content type, not
      // the task name (that lives in the sidebar).
      expect(
        tabs[0].querySelector('.ai-run-pane__tab-label')?.textContent,
      ).toBe('Terminal')

      container
        .querySelector<HTMLElement>('.ai-run-pane__run[data-run-id="run-b"]')
        ?.click()
      tabs = container.querySelectorAll('.ai-run-pane__tab')
      expect(tabs).toHaveLength(1)
      expect(tabs[0].getAttribute('data-run-id')).toBe('run-b')
      expect(
        tabs[0].querySelector('.ai-run-pane__tab-label')?.textContent,
      ).toBe('Events')
      expect(tabs[0].classList.contains('is-active')).toBe(true)
      expect(
        container.querySelector('.ai-run-pane__tab[data-run-id="run-a"]'),
      ).toBeNull()
    })

    test('sidebar and content live inside a layout row that collapse hides', () => {
      controller.mount(container)
      manager.emit(createRun())

      const layout = container.querySelector('.ai-run-pane__layout')
      expect(layout).not.toBeNull()
      expect(layout?.querySelector('.ai-run-pane__sidebar')).not.toBeNull()
      expect(layout?.querySelector('.ai-run-pane__content')).not.toBeNull()

      const toggle = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__collapse',
      )
      toggle?.click()
      expect(pane()?.classList.contains('is-collapsed')).toBe(true)
      toggle?.click()
      expect(pane()?.classList.contains('is-collapsed')).toBe(false)
    })

    test('the composer renders under the content area', () => {
      controller.mount(container)
      manager.emit(createRun({ mode: 'headless', cols: undefined, rows: undefined }))

      const content = container.querySelector('.ai-run-pane__content')
      const composer = container.querySelector('.ai-run-pane__composer')
      expect(composer).not.toBeNull()
      expect(content?.contains(composer)).toBe(true)
    })

    test('relays fitted xterm grid changes to the matching run and disposes the relay', () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-resize' }))

      adapters[0].emitResize(132, 41)
      expect(manager.resizeTerminal).toHaveBeenCalledWith('run-resize', 132, 41)

      controller.unmount()
      manager.resizeTerminal.mockClear()
      adapters[0].emitResize(90, 20)
      expect(manager.resizeTerminal).not.toHaveBeenCalled()
    })
  })

  describe('independent sidebar collapse', () => {
    test('collapses to an icon rail without collapsing the run content and persists it', () => {
      controller.mount(container)
      manager.emit(createRun())

      const toggle = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__sidebar-toggle',
      )
      expect(toggle).not.toBeNull()
      adapters[0].fit.mockClear()
      toggle?.click()

      expect(pane()?.classList.contains('is-sidebar-collapsed')).toBe(true)
      expect(pane()?.classList.contains('is-collapsed')).toBe(false)
      expect(
        container
          .querySelector('.ai-run-pane__body[data-run-id="run-1"]')
          ?.classList.contains('is-active'),
      ).toBe(true)
      expect(saveLocalStorage).toHaveBeenCalledWith(
        AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY,
        true,
      )
      expect(adapters[0].fit).toHaveBeenCalled()

      toggle?.click()
      expect(pane()?.classList.contains('is-sidebar-collapsed')).toBe(false)
      expect(saveLocalStorage).toHaveBeenLastCalledWith(
        AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY,
        false,
      )
    })

    test('restores the collapsed sidebar without re-persisting mount state', () => {
      loadLocalStorage.mockImplementation((key: string) =>
        key === AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY ? true : null,
      )

      controller.mount(container)
      manager.emit(createRun())

      expect(pane()?.classList.contains('is-sidebar-collapsed')).toBe(true)
      expect(saveLocalStorage).not.toHaveBeenCalled()
    })
  })

  describe('workspace Files and terminal drop', () => {
    test('file click opens a 50/50 right editor and can edit, save, and close it', async () => {
      controller.mount(container)
      manager.emit(createRun({ cwd: '/workspace/project' }))
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__sidebar-files')
        ?.click()
      await flushPromises()

      container
        .querySelector<HTMLElement>(
          '.ai-run-pane__file[data-path="/workspace/project/read\'me.md"]',
        )
        ?.click()
      await flushPromises()

      expect(manager.readWorkspaceFile).toHaveBeenCalledWith(
        '/workspace/project',
        "/workspace/project/read'me.md",
      )
      expect(pane()?.classList).toContain('has-file-panel')
      expect(pane()?.classList).toContain('is-expanded')
      expect(container.classList).toContain('ai-pane-container--expanded')
      expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)
      expect(fileEditors[0].document).toBe('Original body\n')
      expect(fileEditors[0].editable).toBe(false)

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__file-edit')
        ?.click()
      fileEditors[0].type('Updated body\n')
      fileEditors[0].saveShortcut()
      await flushPromises()

      expect(manager.writeWorkspaceFile).toHaveBeenCalledWith(
        '/workspace/project',
        "/workspace/project/read'me.md",
        '---\ntitle: Hidden\n---\nUpdated body\n',
        { mtimeMs: 10, size: 43 },
      )
      expect(container.querySelector('.ai-run-pane__file-saved')?.textContent).toBe(
        'Saved',
      )

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__file-tab-close')
        ?.click()
      await flushPromises()
      expect(pane()?.classList).not.toContain('has-file-panel')
      expect(pane()?.classList).not.toContain('is-expanded')
    })

    test('terminal file-path activation opens the same right editor against that run cwd', async () => {
      controller.mount(container)
      manager.emit(
        createRun({ id: 'run-link', cwd: '/workspace/project', cols: 90, rows: 20 }),
      )

      adapters[0].emitFilePath('src/main.ts', 12, 3)
      await flushPromises()

      expect(manager.readWorkspaceFile).toHaveBeenCalledWith(
        '/workspace/project',
        'src/main.ts',
      )
      expect(pane()?.classList).toContain('has-file-panel')
      expect(container.querySelector('.ai-run-pane__file-tab')?.textContent).toContain(
        'main.ts',
      )
    })

    test('folder button opens a lazy file tree and folders can expand', async () => {
      controller.mount(container)
      manager.emit(createRun({ cwd: '/workspace/project' }))

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__sidebar-files')
        ?.click()
      await flushPromises()

      expect(manager.listWorkspaceDirectory).toHaveBeenCalledWith(
        '/workspace/project',
        '/workspace/project',
      )
      const src = container.querySelector<HTMLElement>(
        '.ai-run-pane__file[data-path="/workspace/project/src"]',
      )
      expect(src?.getAttribute('aria-expanded')).toBe('false')

      src?.click()
      await flushPromises()
      expect(manager.listWorkspaceDirectory).toHaveBeenLastCalledWith(
        '/workspace/project',
        'src',
      )
      expect(
        container.querySelector(
          '.ai-run-pane__file[data-path="/workspace/project/src/main.ts"]',
        ),
      ).not.toBeNull()

      container
        .querySelector<HTMLElement>(
          '.ai-run-pane__body[data-run-id="run-1"]',
        )
        ?.click()
      await flushPromises()
      expect(manager.listWorkspaceDirectory).toHaveBeenCalledTimes(2)
      expect(src?.getAttribute('aria-expanded')).toBe('true')
      expect(
        container.querySelector(
          '.ai-run-pane__file[data-path="/workspace/project/src/main.ts"]',
        ),
      ).not.toBeNull()
    })

    test('dropping a file writes one shell-safe path plus a space to that terminal', async () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-drop', cwd: '/workspace/project' }))
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__sidebar-files')
        ?.click()
      await flushPromises()

      const file = container.querySelector<HTMLElement>(
        '.ai-run-pane__file[data-path="/workspace/project/read\'me.md"]',
      )
      const payload = new Map<string, string>()
      const dataTransfer = {
        types: ['application/x-taskchute-workspace-path'],
        setData: (type: string, value: string) => payload.set(type, value),
        getData: (type: string) => payload.get(type) ?? '',
      }
      const dragStart = new Event('dragstart', { bubbles: true })
      Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
      file?.dispatchEvent(dragStart)

      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
      container
        .querySelector<HTMLElement>(
          '.ai-run-pane__body[data-run-id="run-drop"]',
        )
        ?.dispatchEvent(drop)

      expect(manager.sendTerminalInput).toHaveBeenCalledWith(
        'run-drop',
        "'/workspace/project/read'\"'\"'me.md' ",
      )

      manager.sendTerminalInput.mockClear()
      payload.set(
        'application/x-taskchute-workspace-path',
        '/workspace/project/evil\u0003echo pwned',
      )
      const unsafeDrop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(unsafeDrop, 'dataTransfer', { value: dataTransfer })
      container
        .querySelector<HTMLElement>(
          '.ai-run-pane__body[data-run-id="run-drop"]',
        )
        ?.dispatchEvent(unsafeDrop)
      expect(manager.sendTerminalInput).not.toHaveBeenCalled()
    })

    test('dropping a folder writes its shell-safe path without expanding or pressing Enter', async () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-folder-drop', cwd: '/workspace/project' }))
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__sidebar-files')
        ?.click()
      await flushPromises()

      const folder = container.querySelector<HTMLElement>(
        '.ai-run-pane__file[data-path="/workspace/project/src"]',
      )
      const payload = new Map<string, string>()
      const dataTransfer = {
        types: ['application/x-taskchute-workspace-path'],
        setData: (type: string, value: string) => payload.set(type, value),
        getData: (type: string) => payload.get(type) ?? '',
      }
      const dragStart = new Event('dragstart', { bubbles: true })
      Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
      folder?.dispatchEvent(dragStart)

      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
      container
        .querySelector<HTMLElement>(
          '.ai-run-pane__body[data-run-id="run-folder-drop"]',
        )
        ?.dispatchEvent(drop)

      expect(folder?.getAttribute('draggable')).toBe('true')
      expect(folder?.getAttribute('aria-expanded')).toBe('false')
      expect(manager.listWorkspaceDirectory).toHaveBeenCalledTimes(1)
      expect(manager.sendTerminalInput).toHaveBeenCalledWith(
        'run-folder-drop',
        "'/workspace/project/src' ",
      )
    })

    test('rejects forged and drag-time-substituted workspace path payloads', async () => {
      controller.mount(container)
      manager.emit(createRun({ id: 'run-forged-drop', cwd: '/workspace/project' }))
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__sidebar-files')
        ?.click()
      await flushPromises()

      const payload = new Map<string, string>([
        ['application/x-taskchute-workspace-path', '/etc/passwd'],
      ])
      const dataTransfer = {
        types: ['application/x-taskchute-workspace-path'],
        setData: (type: string, value: string) => payload.set(type, value),
        getData: (type: string) => payload.get(type) ?? '',
      }
      const body = container.querySelector<HTMLElement>(
        '.ai-run-pane__body[data-run-id="run-forged-drop"]',
      )

      // A custom MIME type by itself is not provenance: only a drag started
      // by this pane's validated Files tree may insert terminal input.
      const forgedDrop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(forgedDrop, 'dataTransfer', { value: dataTransfer })
      body?.dispatchEvent(forgedDrop)
      expect(manager.sendTerminalInput).not.toHaveBeenCalled()

      const folder = container.querySelector<HTMLElement>(
        '.ai-run-pane__file[data-path="/workspace/project/src"]',
      )
      const dragStart = new Event('dragstart', { bubbles: true })
      Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
      folder?.dispatchEvent(dragStart)

      const dragEnd = new Event('dragend', { bubbles: true })
      folder?.dispatchEvent(dragEnd)
      const afterDragEndDrop = new Event('drop', {
        bubbles: true,
        cancelable: true,
      })
      Object.defineProperty(afterDragEndDrop, 'dataTransfer', {
        value: dataTransfer,
      })
      body?.dispatchEvent(afterDragEndDrop)
      expect(manager.sendTerminalInput).not.toHaveBeenCalled()

      // A fresh internal drag authorizes only its exact validated path.
      folder?.dispatchEvent(dragStart)
      payload.set('application/x-taskchute-workspace-path', '/etc/passwd')

      const substitutedDrop = new Event('drop', {
        bubbles: true,
        cancelable: true,
      })
      Object.defineProperty(substitutedDrop, 'dataTransfer', {
        value: dataTransfer,
      })
      body?.dispatchEvent(substitutedDrop)
      expect(manager.sendTerminalInput).not.toHaveBeenCalled()

      // The rejected drop clears provenance; replaying the original path
      // without a fresh internal dragstart is rejected as well.
      payload.set(
        'application/x-taskchute-workspace-path',
        '/workspace/project/src',
      )
      const replayDrop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(replayDrop, 'dataTransfer', { value: dataTransfer })
      body?.dispatchEvent(replayDrop)
      expect(manager.sendTerminalInput).not.toHaveBeenCalled()
    })

    test('a failed folder expansion can be collapsed and retried', async () => {
      controller.mount(container)
      manager.emit(createRun({ cwd: '/workspace/project' }))
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__sidebar-files')
        ?.click()
      await flushPromises()
      const src = container.querySelector<HTMLElement>(
        '.ai-run-pane__file[data-path="/workspace/project/src"]',
      )
      manager.failNextWorkspaceDirectory = true

      src?.click()
      await flushPromises()
      expect(container.querySelector('.ai-run-pane__files-message')).not.toBeNull()

      src?.click()
      src?.click()
      await flushPromises()
      expect(
        container.querySelector(
          '.ai-run-pane__file[data-path="/workspace/project/src/main.ts"]',
        ),
      ).not.toBeNull()
    })

    test('a failed root load retries when Files is opened again', async () => {
      controller.mount(container)
      manager.emit(createRun({ cwd: '/workspace/project' }))
      manager.failNextWorkspaceRoot = true
      const filesButton = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__sidebar-files',
      )

      filesButton?.click()
      await flushPromises()
      expect(container.querySelector('.ai-run-pane__files-message')).not.toBeNull()

      filesButton?.click()
      filesButton?.click()
      await flushPromises()
      expect(
        container.querySelector(
          '.ai-run-pane__file[data-path="/workspace/project/src"]',
        ),
      ).not.toBeNull()
    })
  })

  describe('× stop-and-close semantics', () => {
    test('× on an active run requests stop and keeps the view until persisted', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-active' })
      manager.emit(run)

      const close = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__tab-close',
      )
      expect(close).not.toBeNull()
      expect(close?.getAttribute('aria-label')).toBe('Stop and close run')
      close?.click()

      expect(manager.stopRun).toHaveBeenCalledWith('run-active')
      expect(onStopAndCloseTaskRun).toHaveBeenCalledTimes(1)
      expect(onStopAndCloseTaskRun).toHaveBeenCalledWith(run)
      // Nothing closes on the click itself...
      expect(rows()).toHaveLength(1)
      expect(adapters[0].disposed).toBe(false)

      // ...nor on the final status update (snapshot not yet consumed)...
      run.status = 'stopped'
      manager.emit(run)
      expect(rows()).toHaveLength(1)
      expect(adapters[0].disposed).toBe(false)
      expect(manager.snapshotProvider?.(run.id)).toBe('fake terminal snapshot')

      // ...only the end of the persist chain tears the view down.
      manager.emit(run, 'persisted')
      expect(rows()).toHaveLength(0)
      expect(bodies()).toHaveLength(0)
      expect(adapters[0].disposed).toBe(true)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })

    test('repeated × requests synchronize the task only once', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-repeat' })
      manager.emit(run)

      const close = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__tab-close',
      )
      close?.click()
      close?.click()

      expect(onStopAndCloseTaskRun).toHaveBeenCalledTimes(1)
      expect(manager.stopRun).toHaveBeenCalledTimes(1)
    })

    test('× on an active shell run does not change a TaskChute task', () => {
      controller.mount(container)
      const run = createRun({
        id: 'shell-run',
        host: 'shell',
        taskPath: '',
        taskName: 'Terminal',
      })
      manager.emit(run)

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      expect(manager.stopRun).toHaveBeenCalledWith('shell-run')
      expect(onStopAndCloseTaskRun).not.toHaveBeenCalled()
    })

    test('× requested on an active run closes on persisted even when it finishes as succeeded', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-race' })
      manager.emit(run)

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      // The run finished on its own before the stop landed.
      run.status = 'succeeded'
      manager.emit(run)
      expect(rows()).toHaveLength(1)

      manager.emit(run, 'persisted')
      // Without the pending close a succeeded run would keep its row.
      expect(rows()).toHaveLength(0)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })

    test('× on a finished run closes immediately', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-done' })
      manager.emit(run)
      run.status = 'succeeded'
      manager.emit(run)
      manager.emit(run, 'persisted')

      const close = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__tab-close',
      )
      expect(close?.getAttribute('aria-label')).toBe('Close run tab')
      close?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(onStopAndCloseTaskRun).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(0)
      expect(adapters[0].disposed).toBe(true)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })

    test('a restored interrupted run is visible as non-active and can be closed', () => {
      const run = createRun({ id: 'run-interrupted', status: 'interrupted' })
      manager.records.push(run)
      controller.mount(container)

      expect(
        container.querySelector('.ai-run-pane__run-dot--interrupted'),
      ).not.toBeNull()
      const close = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__tab-close',
      )
      expect(close?.getAttribute('aria-label')).toBe('Close run tab')
      close?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(onStopAndCloseTaskRun).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(0)
    })

    test('the sidebar row × mirrors the tab × for active runs', () => {
      controller.mount(container)
      const runA = createRun({ id: 'run-a', taskPath: 'TASKS/a.md' })
      const runB = createRun({ id: 'run-b', taskPath: 'TASKS/b.md' })
      manager.emit(runA)
      manager.emit(runB)

      const rowClose = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__run[data-run-id="run-b"] .ai-run-pane__run-close',
      )
      expect(rowClose).not.toBeNull()
      expect(rowClose?.getAttribute('aria-label')).toBe('Stop and close run')
      rowClose?.click()

      expect(manager.stopRun).toHaveBeenCalledWith('run-b')
      // Clicking the × must not bubble into row selection.
      expect(
        container
          .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
          ?.classList.contains('is-active'),
      ).toBe(true)

      runB.status = 'stopped'
      manager.emit(runB)
      manager.emit(runB, 'persisted')
      expect(rows()).toHaveLength(1)
    })

    test('the sidebar row × closes a finished run immediately', () => {
      controller.mount(container)
      const run = createRun({ id: 'run-done' })
      manager.emit(run)
      run.status = 'failed'
      manager.emit(run)
      manager.emit(run, 'persisted')

      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__run-close')
        ?.click()

      expect(manager.stopRun).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(0)
      expect(pane()?.classList.contains('is-hidden')).toBe(true)
    })
  })

  describe('expand toggle', () => {
    test('lives once in the global AI Runs header instead of a panel tab strip', () => {
      controller.mount(container)
      manager.emit(createRun())

      const expand = container.querySelector('.ai-run-pane__expand')
      expect(expand).not.toBeNull()
      expect(expand?.parentElement?.classList).toContain(
        'ai-run-pane__header-actions',
      )
      expect(expand?.closest('.ai-run-pane__header')).not.toBeNull()
      expect(expand?.closest('.ai-run-pane__tabstrip')).toBeNull()
      expect(container.querySelectorAll('.ai-run-pane__expand')).toHaveLength(1)
    })

    test('toggles the expanded classes and persists the state per device', () => {
      controller.mount(container)
      manager.emit(createRun())

      const expand = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__expand',
      )
      expect(expand).not.toBeNull()
      expect(expand?.getAttribute('aria-label')).toBeTruthy()

      adapters[0].fit.mockClear()
      expand?.click()
      expect(pane()?.classList.contains('is-expanded')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
      expect(saveLocalStorage).toHaveBeenCalledWith(
        AI_PANE_EXPANDED_STORAGE_KEY,
        true,
      )
      expect(adapters[0].fit).toHaveBeenCalled()

      expand?.click()
      expect(pane()?.classList.contains('is-expanded')).toBe(false)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(false)
      expect(saveLocalStorage).toHaveBeenLastCalledWith(
        AI_PANE_EXPANDED_STORAGE_KEY,
        false,
      )
    })

    test('mount restores the persisted expanded state', () => {
      loadLocalStorage.mockReturnValue(true)
      controller.mount(container)
      manager.emit(createRun())

      expect(loadLocalStorage).toHaveBeenCalledWith(AI_PANE_EXPANDED_STORAGE_KEY)
      expect(pane()?.classList.contains('is-expanded')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
      // Restoring is not a user toggle; nothing is re-persisted.
      expect(saveLocalStorage).not.toHaveBeenCalled()
    })

    test('collapsing drops the expanded container chrome and re-expanding restores it', () => {
      controller.mount(container)
      manager.emit(createRun())
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__expand')
        ?.click()
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)

      controller.setCollapsed(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(false)
      // The pane itself remembers the expanded preference.
      expect(pane()?.classList.contains('is-expanded')).toBe(true)

      controller.setCollapsed(false)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
    })

    test('header expand reveals a collapsed pane instead of toggling hidden state only', () => {
      controller.mount(container)
      manager.emit(createRun())
      const expand = container.querySelector<HTMLButtonElement>(
        '.ai-run-pane__expand',
      )

      controller.setCollapsed(true)
      expect(expand?.getAttribute('aria-pressed')).toBe('false')
      expand?.click()

      expect(pane()?.classList.contains('is-collapsed')).toBe(false)
      expect(pane()?.classList.contains('is-expanded')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)
      expect(expand?.getAttribute('aria-pressed')).toBe('true')
      expect(saveLocalStorage).toHaveBeenLastCalledWith(
        AI_PANE_EXPANDED_STORAGE_KEY,
        true,
      )
    })

    test('closing the last run removes the expanded container chrome with the pane', () => {
      controller.mount(container)
      const run = createRun()
      manager.emit(run)
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__expand')
        ?.click()

      run.status = 'succeeded'
      manager.emit(run)
      manager.emit(run, 'persisted')
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
        ?.click()

      expect(pane()?.classList.contains('is-hidden')).toBe(true)
      expect(container.classList.contains('ai-pane-container--expanded')).toBe(false)
    })

    test('computeTerminalSize uses the taller share while expanded', () => {
      controller.mount(container)
      Object.defineProperty(container, 'clientWidth', {
        configurable: true,
        value: 816,
      })
      Object.defineProperty(document.body, 'clientHeight', {
        configurable: true,
        value: 1000,
      })
      manager.emit(createRun())

      const normal = controller.computeTerminalSize()
      container
        .querySelector<HTMLButtonElement>('.ai-run-pane__expand')
        ?.click()
      const expanded = controller.computeTerminalSize()

      expect(expanded.rows).toBeGreaterThan(normal.rows)
      expect(expanded.cols).toBe(normal.cols)
    })
  })
})

// ---------------------------------------------------------------------------
// Integration: real AiTaskManager — × ordering around the persist chain
// ---------------------------------------------------------------------------

class IntegrationTerminalDispatcher implements AiTerminalDispatcher {
  callbacks: TerminalRunCallbacks | null = null
  readonly stop = jest.fn()

  start(_request: TerminalRunRequest, callbacks: TerminalRunCallbacks) {
    this.callbacks = callbacks
    return { pid: 4242, write: jest.fn(), stop: this.stop, forceKill: jest.fn() }
  }

  exit(outcome: AiRunExitOutcome): void {
    this.callbacks?.onExit(outcome)
  }
}

describe('AiRunPaneController × + AiTaskManager persist ordering', () => {
  test('the × close never disposes the adapter before the snapshot provider was consumed', async () => {
    const terminalDispatcher = new IntegrationTerminalDispatcher()
    let adapterDisposedAtPersist: boolean | null = null
    const adapters: FakeTerminalAdapter[] = []
    const writeTerminalRunLog = jest.fn<Promise<string>, [AiRunRecord, string]>(
      async () => {
        adapterDisposedAtPersist = adapters[0]?.disposed ?? null
        return 'terminal-log.md'
      },
    )
    const headlessDispatcher: AiDispatcher = {
      start: () => {
        throw new Error('headless dispatch not expected')
      },
    }
    const deps: AiTaskManagerDeps = {
      app: {
        vault: {
          cachedRead: jest.fn(async () => '# Task\n\n## Prompt\n\nGo\n'),
          adapter: { getBasePath: () => '/vault/base' },
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({ frontmatter: { ai_task: true } })),
        },
      },
      dispatchers: { claude: headlessDispatcher, codex: headlessDispatcher },
      binaryLocator: { resolve: jest.fn(async () => '/bin/claude') },
      logWriter: {
        writeRunLog: jest.fn(async () => 'log.md'),
        writeTerminalRunLog,
        pruneOldLogs: jest.fn(async () => undefined),
      },
      terminal: {
        dispatcher: terminalDispatcher,
        isSupported: () => true,
        makeTempFilePath: (prefix: string) => `/tmp/${prefix}.log`,
        readAndDeleteFile: jest.fn(async () => 'raw transcript'),
      },
      getRunMode: () => 'terminal',
    }
    const manager = new AiTaskManager(deps)

    document.body.replaceChildren()
    const container = document.body.createDiv({ cls: 'ai-pane-container' })
    const controller = new AiRunPaneController({
      tv: (_key, fallback) => fallback,
      manager,
      createTerminalAdapter: () => {
        const adapter = new FakeTerminalAdapter()
        adapter.snapshot = 'live screen at exit'
        adapters.push(adapter)
        return adapter
      },
      registerManagedDisposer: () => undefined,
    })
    controller.mount(container)

    const file = new TFile()
    file.path = 'TASKS/ai.md'
    file.basename = 'ai'
    file.extension = 'md'
    await manager.startRun(file)
    expect(adapters).toHaveLength(1)

    // × on the running tab: requests the stop through the real manager...
    container
      .querySelector<HTMLButtonElement>('.ai-run-pane__tab-close')
      ?.click()
    expect(terminalDispatcher.stop).toHaveBeenCalledTimes(1)
    expect(adapters[0].disposed).toBe(false)

    // ...the child exits, the persist chain consumes the LIVE snapshot...
    terminalDispatcher.exit({ status: 'stopped', exitCode: null, signal: null })
    await flushPromises()

    expect(writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(writeTerminalRunLog.mock.calls[0][1]).toBe('live screen at exit')
    expect(adapterDisposedAtPersist).toBe(false)
    // ...and only afterwards is the view torn down.
    expect(adapters[0].disposed).toBe(true)
    expect(container.querySelectorAll('.ai-run-pane__run')).toHaveLength(0)
    expect(
      container.querySelector('.ai-run-pane')?.classList.contains('is-hidden'),
    ).toBe(true)

    controller.unmount()
  })
})
