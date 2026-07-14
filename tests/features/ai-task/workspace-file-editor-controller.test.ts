import type {
  FileEditorAdapterLike,
  FileEditorOpenOptions,
} from '../../../src/features/ai-task/ui/FileEditorAdapter'
import {
  getWorkspaceFileTabIcon,
  WorkspaceFileEditorController,
  type WorkspaceFileDocument,
  type WorkspaceFileEditorHost,
} from '../../../src/features/ai-task/ui/WorkspaceFileEditorController'

class FakeFileEditorAdapter implements FileEditorAdapterLike {
  document = ''
  languagePath: string | null = null
  editable = false
  disposed = false
  focused = false
  private onChange: ((document: string) => void) | null = null
  private onSave: (() => void) | null = null

  open(container: HTMLElement, options: FileEditorOpenOptions): void {
    container.dataset.fakeEditor = 'true'
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

  focus(): void {
    this.focused = true
  }

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

function documentResult(
  absolutePath: string,
  content: string,
  version = { mtimeMs: 10, size: content.length },
): WorkspaceFileDocument {
  return {
    rootPath: '/workspace',
    relativePath: absolutePath.replace('/workspace/', ''),
    absolutePath,
    content,
    version,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('WorkspaceFileEditorController', () => {
  let container: HTMLElement
  let editor: FakeFileEditorAdapter
  let host: WorkspaceFileEditorHost
  let controller: WorkspaceFileEditorController
  let confirmDiscard: jest.MockedFunction<(path: string) => boolean | Promise<boolean>>

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.body.createDiv()
    editor = new FakeFileEditorAdapter()
    confirmDiscard = jest.fn(() => true)
    host = {
      readWorkspaceFile: jest.fn(async (_rootPath, filePath) =>
        documentResult(filePath, 'plain text'),
      ),
      writeWorkspaceFile: jest.fn(async (_rootPath, filePath, content) =>
        documentResult(filePath, content, { mtimeMs: 20, size: content.length }),
      ),
      onVisibilityChange: jest.fn(),
      confirmDiscard,
      onError: jest.fn(),
    }
    controller = new WorkspaceFileEditorController(container, host, () => editor)
  })

  afterEach(() => controller.dispose())

  test.each([
    ['component.tsx', '📘'],
    ['component.ts', '📘'],
    ['README.md', '📝'],
    ['package.json', '📋'],
    ['theme.css', '🎨'],
    ['index.html', '🌐'],
    ['publish.js', '📙'],
    ['notes.txt', '📄'],
  ])('uses the reference file icon for %s', (title, expected) => {
    expect(getWorkspaceFileTabIcon(title)).toBe(expected)
  })

  test('opens a file read-only, hides Markdown frontmatter, and deduplicates its canonical path', async () => {
    ;(host.readWorkspaceFile as jest.Mock).mockResolvedValue(
      documentResult(
        '/workspace/notes/example.md',
        '---\ntitle: Hidden\ntags:\n  - private\n---\n# Visible\n\nBody\n',
      ),
    )

    await controller.openFile('/workspace', '/workspace/notes/example.md')

    expect(host.onVisibilityChange).toHaveBeenCalledWith(true)
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)
    const header = container.querySelector('.ai-run-pane__file-panel-header')
    const tab = container.querySelector('.ai-run-pane__file-tab')
    expect(header?.classList).toContain('ai-run-pane__work-tabbar')
    expect(tab?.classList).toContain('ai-run-pane__work-tab')
    expect(tab?.getAttribute('role')).toBe('tab')
    expect(tab?.getAttribute('aria-selected')).toBe('true')
    expect(tab?.getAttribute('tabindex')).toBe('0')
    expect(tab?.querySelector('.ai-run-pane__file-tab-select')).toBeNull()
    expect(tab?.querySelector('.ai-run-pane__file-tab-icon')?.textContent).toBe('📝')
    expect(tab?.textContent).toContain('example.md')
    expect(editor.document).toBe('# Visible\n\nBody\n')
    expect(editor.languagePath).toBe('/workspace/notes/example.md')
    expect(editor.document).not.toContain('title: Hidden')
    expect(editor.editable).toBe(false)
    expect(container.querySelector('.ai-run-pane__file-edit')).not.toBeNull()

    await controller.openFile('/workspace', '/workspace/notes/example.md')

    expect(host.readWorkspaceFile).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)
  })

  test('Pencil enables editing and Save/Cmd-S rejoin frontmatter while keeping edit mode active', async () => {
    const original = '---\ntitle: Keep me\n---\nOld body\n'
    ;(host.readWorkspaceFile as jest.Mock).mockResolvedValue(
      documentResult('/workspace/note.md', original),
    )
    await controller.openFile('/workspace', '/workspace/note.md')

    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    expect(editor.editable).toBe(true)

    editor.type('New body\n')
    expect(container.querySelector('.ai-run-pane__file-save')).not.toBeNull()
    expect(container.querySelector('.ai-run-pane__file-tab')?.classList).toContain(
      'is-dirty',
    )

    editor.saveShortcut()
    await flushAsyncEvents()

    expect(host.writeWorkspaceFile).toHaveBeenCalledWith(
      '/workspace',
      '/workspace/note.md',
      '---\ntitle: Keep me\n---\nNew body\n',
      { mtimeMs: 10, size: original.length },
    )
    expect(editor.editable).toBe(true)
    expect(editor.document).toBe('New body\n')
    expect(container.querySelector('.ai-run-pane__file-saved')?.textContent).toBe(
      'Saved',
    )
    expect(container.querySelector('.ai-run-pane__file-tab')?.classList).not.toContain(
      'is-dirty',
    )
  })

  test('inserts a line break before the first body added to frontmatter-only Markdown', async () => {
    const original = '---\ntitle: Keep me\n---'
    ;(host.readWorkspaceFile as jest.Mock).mockResolvedValue(
      documentResult('/workspace/frontmatter-only.md', original),
    )
    await controller.openFile('/workspace', '/workspace/frontmatter-only.md')

    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    editor.type('First body line\n')
    ;(container.querySelector('.ai-run-pane__file-save') as HTMLButtonElement).click()
    await flushAsyncEvents()

    expect(host.writeWorkspaceFile).toHaveBeenCalledWith(
      '/workspace',
      '/workspace/frontmatter-only.md',
      '---\ntitle: Keep me\n---\nFirst body line\n',
      { mtimeMs: 10, size: original.length },
    )
  })

  test('disables and rejects Cancel and close while a save is in flight', async () => {
    const save = deferred<WorkspaceFileDocument>()
    ;(host.writeWorkspaceFile as jest.Mock).mockReturnValueOnce(save.promise)
    await controller.openFile('/workspace', '/workspace/race.txt')
    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    editor.type('saved draft')
    ;(container.querySelector('.ai-run-pane__file-save') as HTMLButtonElement).click()
    await flushAsyncEvents()

    expect(
      (container.querySelector('.ai-run-pane__file-cancel') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (container.querySelector('.ai-run-pane__file-tab-close') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await expect(controller.cancelActiveEdit()).resolves.toBe(false)
    await expect(controller.closeActiveFile()).resolves.toBe(false)
    expect(editor.editable).toBe(true)
    expect(editor.document).toBe('saved draft')
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)

    save.resolve(
      documentResult('/workspace/race.txt', 'saved draft', {
        mtimeMs: 30,
        size: 11,
      }),
    )
    await flushAsyncEvents()

    expect(editor.document).toBe('saved draft')
    expect(
      (container.querySelector('.ai-run-pane__file-cancel') as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  test('Cancel and dirty close require confirmation and preserve the draft when declined', async () => {
    await controller.openFile('/workspace', '/workspace/draft.txt')
    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    editor.type('unsaved')
    confirmDiscard.mockReturnValue(false)

    ;(container.querySelector('.ai-run-pane__file-cancel') as HTMLButtonElement).click()
    await flushAsyncEvents()

    expect(confirmDiscard).toHaveBeenCalledWith('/workspace/draft.txt')
    expect(editor.editable).toBe(true)
    expect(editor.document).toBe('unsaved')

    ;(container.querySelector('.ai-run-pane__file-tab-close') as HTMLButtonElement).click()
    await flushAsyncEvents()
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)

    confirmDiscard.mockReturnValue(true)
    ;(container.querySelector('.ai-run-pane__file-cancel') as HTMLButtonElement).click()
    await flushAsyncEvents()

    expect(editor.editable).toBe(false)
    expect(editor.document).toBe('plain text')
  })

  test('keeps independent drafts across file tabs and closes the panel after the last tab', async () => {
    await controller.openFile('/workspace', '/workspace/one.txt')
    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    editor.type('draft one')
    await controller.openFile('/workspace', '/workspace/two.txt')

    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(2)
    expect(editor.document).toBe('plain text')
    expect(editor.languagePath).toBe('/workspace/two.txt')
    expect(editor.editable).toBe(false)

    const tabs = Array.from(
      container.querySelectorAll<HTMLElement>('.ai-run-pane__file-tab'),
    )
    tabs[0].click()
    expect(editor.document).toBe('draft one')
    expect(editor.editable).toBe(true)
    expect(editor.languagePath).toBe('/workspace/one.txt')

    const activeKeyboardTab = container.querySelector<HTMLElement>(
      '.ai-run-pane__file-tab.is-active',
    )
    activeKeyboardTab?.focus()
    activeKeyboardTab?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    expect(editor.languagePath).toBe('/workspace/two.txt')
    expect(document.activeElement?.getAttribute('data-file-tab-id')).toBe('2')

    confirmDiscard.mockReturnValue(true)
    const tabClick = jest.fn()
    const tabToClose = container.querySelector<HTMLElement>(
      '.ai-run-pane__file-tab',
    )
    tabToClose?.addEventListener('click', tabClick)
    const closeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.ai-run-pane__file-tab-close'),
    )
    closeButtons[0].click()
    await flushAsyncEvents()
    expect(tabClick).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)
    expect(host.onVisibilityChange).not.toHaveBeenCalledWith(false)

    ;(container.querySelector('.ai-run-pane__file-tab-close') as HTMLButtonElement).click()
    await flushAsyncEvents()
    expect(host.onVisibilityChange).toHaveBeenLastCalledWith(false)
    expect(controller.hasOpenFiles()).toBe(false)
    expect(editor.languagePath).toBeNull()
  })

  test('ignores a late read after its tab closes and never replaces the active file', async () => {
    const slowRead = deferred<WorkspaceFileDocument>()
    ;(host.readWorkspaceFile as jest.Mock)
      .mockReturnValueOnce(slowRead.promise)
      .mockResolvedValueOnce(documentResult('/workspace/fast.txt', 'fast content'))

    const slowOpen = controller.openFile('/workspace', '/workspace/slow.txt')
    await flushAsyncEvents()
    ;(container.querySelector('.ai-run-pane__file-tab-close') as HTMLButtonElement).click()
    await flushAsyncEvents()
    await controller.openFile('/workspace', '/workspace/fast.txt')
    expect(editor.document).toBe('fast content')

    slowRead.resolve(documentResult('/workspace/slow.txt', 'late content'))
    await slowOpen

    expect(editor.document).toBe('fast content')
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(1)
  })

  test('a background save response updates only its own tab and does not clobber the active editor', async () => {
    const save = deferred<WorkspaceFileDocument>()
    ;(host.writeWorkspaceFile as jest.Mock).mockReturnValueOnce(save.promise)
    await controller.openFile('/workspace', '/workspace/one.txt')
    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    editor.type('saved one')
    ;(container.querySelector('.ai-run-pane__file-save') as HTMLButtonElement).click()
    await flushAsyncEvents()
    await controller.openFile('/workspace', '/workspace/two.txt')
    expect(editor.document).toBe('plain text')

    save.resolve(
      documentResult('/workspace/one.txt', 'saved one', { mtimeMs: 30, size: 9 }),
    )
    await flushAsyncEvents()

    expect(editor.document).toBe('plain text')
    expect(
      container.querySelector('.ai-run-pane__file-tab.is-active')?.textContent,
    ).toContain('two.txt')
  })

  test('does not overwrite edits typed while a save is in flight', async () => {
    const save = deferred<WorkspaceFileDocument>()
    ;(host.writeWorkspaceFile as jest.Mock).mockReturnValueOnce(save.promise)
    await controller.openFile('/workspace', '/workspace/race.txt')
    ;(container.querySelector('.ai-run-pane__file-edit') as HTMLButtonElement).click()
    editor.type('first edit')
    ;(container.querySelector('.ai-run-pane__file-save') as HTMLButtonElement).click()
    await flushAsyncEvents()
    editor.type('second edit')

    save.resolve(
      documentResult('/workspace/race.txt', 'first edit', { mtimeMs: 30, size: 10 }),
    )
    await flushAsyncEvents()

    expect(editor.document).toBe('second edit')
    expect(container.querySelector('.ai-run-pane__file-tab')?.classList).toContain(
      'is-dirty',
    )
  })

  test('read failure removes the failed tab, reports the error, and restores unsplit visibility', async () => {
    const failure = new Error('unsafe file')
    ;(host.readWorkspaceFile as jest.Mock).mockRejectedValue(failure)

    await controller.openFile('/workspace', '/workspace/unsafe.txt')

    expect(host.onError).toHaveBeenCalledWith(failure)
    expect(container.querySelectorAll('.ai-run-pane__file-tab')).toHaveLength(0)
    expect(host.onVisibilityChange).toHaveBeenLastCalledWith(false)
    expect(editor.document).toBe('')
  })
})
