import { setIcon } from 'obsidian'
import type {
  WorkspaceFileDocument,
  WorkspaceFileVersion,
} from '../services/WorkspaceFileService'
import {
  createFileEditorAdapter,
  type FileEditorAdapterFactory,
  type FileEditorAdapterLike,
} from './FileEditorAdapter'

export type { WorkspaceFileDocument, WorkspaceFileVersion }

export interface WorkspaceFileEditorLabels {
  edit: string
  save: string
  cancel: string
  saved: string
  saving: string
  loading: string
  saveFailed: string
  close: string
  discardConfirmation: string
}

export interface WorkspaceFileEditorHost {
  readWorkspaceFile(
    rootPath: string,
    filePath: string,
  ): Promise<WorkspaceFileDocument>
  writeWorkspaceFile(
    rootPath: string,
    filePath: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
  ): Promise<WorkspaceFileDocument>
  /** The pane host uses this to enter/leave the terminal + file 50/50 split. */
  onVisibilityChange(visible: boolean): void
  /** Override for Obsidian-native confirmation UI; window.confirm is fallback. */
  confirmDiscard?(absolutePath: string): boolean | Promise<boolean>
  onError?(error: unknown): void
  labels?: Partial<WorkspaceFileEditorLabels>
}

type LoadState = 'loading' | 'ready'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface FileTabState {
  id: number
  requestKey: string
  rootPath: string
  requestedPath: string
  relativePath: string
  absolutePath: string | null
  title: string
  loadState: LoadState
  readRequestId: number
  saveRequestId: number
  version: WorkspaceFileVersion | null
  frontmatter: string
  originalBody: string
  draft: string
  editing: boolean
  saveState: SaveState
}

const DEFAULT_LABELS: WorkspaceFileEditorLabels = {
  edit: 'Edit',
  save: 'Save (Cmd/Ctrl+S)',
  cancel: 'Cancel',
  saved: 'Saved',
  saving: 'Saving…',
  loading: 'Loading…',
  saveFailed: 'Save failed',
  close: 'Close file',
  discardConfirmation: 'You have unsaved changes. Discard them?',
}

/**
 * Multiple-tab file panel controller shared by Files clicks and terminal path
 * links. Filesystem access is injected through the host; this class only owns
 * tab/editor state and DOM rendering.
 */
export class WorkspaceFileEditorController {
  private readonly panel: HTMLElement
  private readonly tabsContainer: HTMLElement
  private readonly actionsContainer: HTMLElement
  private readonly editorContainer: HTMLElement
  private readonly loadingStatus: HTMLElement
  private readonly editor: FileEditorAdapterLike
  private readonly labels: WorkspaceFileEditorLabels
  private readonly tabs: FileTabState[] = []
  private activeTabId: number | null = null
  private nextTabId = 0
  private nextRequestId = 0
  private visible = false
  private disposed = false

  constructor(
    private readonly container: HTMLElement,
    private readonly host: WorkspaceFileEditorHost,
    editorFactory: FileEditorAdapterFactory = createFileEditorAdapter,
  ) {
    this.labels = { ...DEFAULT_LABELS, ...host.labels }
    this.container.empty()
    this.panel = this.container.createDiv({ cls: 'ai-run-pane__file-panel' })
    const header = this.panel.createDiv({ cls: 'ai-run-pane__file-panel-header' })
    this.tabsContainer = header.createDiv({
      cls: 'ai-run-pane__file-tabs',
      attr: { role: 'tablist' },
    })
    this.actionsContainer = header.createDiv({ cls: 'ai-run-pane__file-actions' })
    const body = this.panel.createDiv({ cls: 'ai-run-pane__file-editor-body' })
    this.editorContainer = body.createDiv({ cls: 'ai-run-pane__file-editor' })
    this.loadingStatus = body.createDiv({
      cls: 'ai-run-pane__file-editor-status is-hidden',
      attr: { role: 'status' },
    })
    this.editor = editorFactory()
    this.editor.open(this.editorContainer, {
      document: '',
      editable: false,
      onChange: (document) => this.handleEditorChange(document),
      onSave: () => {
        void this.saveActiveFile()
      },
    })
    this.render()
  }

  hasOpenFiles(): boolean {
    return this.tabs.length > 0
  }

  /** Open or select a file. The host validates and canonicalizes every read. */
  async openFile(
    rootPath: string,
    filePath: string,
    title?: string,
  ): Promise<void> {
    if (this.disposed) return
    const requestKey = getRequestKey(rootPath, filePath)
    const existing = this.tabs.find(
      (tab) =>
        tab.requestKey === requestKey ||
        (tab.absolutePath !== null && tab.absolutePath === filePath),
    )
    if (existing) {
      this.activateTab(existing.id)
      return
    }

    const tab: FileTabState = {
      id: ++this.nextTabId,
      requestKey,
      rootPath,
      requestedPath: filePath,
      relativePath: filePath,
      absolutePath: null,
      title: title ?? getPathBasename(filePath),
      loadState: 'loading',
      readRequestId: ++this.nextRequestId,
      saveRequestId: 0,
      version: null,
      frontmatter: '',
      originalBody: '',
      draft: '',
      editing: false,
      saveState: 'idle',
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.setVisible(true)
    this.syncEditorToActiveTab()
    this.render()

    const readRequestId = tab.readRequestId
    try {
      const result = await this.host.readWorkspaceFile(rootPath, filePath)
      if (!this.isCurrentRead(tab, readRequestId)) return

      const canonicalDuplicate = this.tabs.find(
        (candidate) =>
          candidate.id !== tab.id &&
          candidate.absolutePath === result.absolutePath,
      )
      if (canonicalDuplicate) {
        this.removeTabWithoutConfirmation(tab.id)
        this.activateTab(canonicalDuplicate.id)
        return
      }

      const content = splitEditableContent(result.absolutePath, result.content)
      tab.rootPath = result.rootPath
      tab.relativePath = result.relativePath
      tab.absolutePath = result.absolutePath
      tab.title = title ?? getPathBasename(result.relativePath || result.absolutePath)
      tab.loadState = 'ready'
      tab.version = result.version
      tab.frontmatter = content.frontmatter
      tab.originalBody = content.body
      tab.draft = content.body
      if (this.activeTabId === tab.id) this.syncEditorToActiveTab()
      this.render()
    } catch (error) {
      if (!this.isCurrentRead(tab, readRequestId)) return
      this.host.onError?.(error)
      this.removeTabWithoutConfirmation(tab.id)
    }
  }

  async closeFile(filePath: string): Promise<boolean> {
    const tab = this.tabs.find(
      (candidate) =>
        candidate.absolutePath === filePath || candidate.requestedPath === filePath,
    )
    if (!tab) return false
    return await this.closeTab(tab.id)
  }

  async closeActiveFile(): Promise<boolean> {
    if (this.activeTabId === null) return false
    return await this.closeTab(this.activeTabId)
  }

  async saveActiveFile(): Promise<void> {
    const tab = this.getActiveTab()
    if (
      !tab ||
      tab.loadState !== 'ready' ||
      !tab.editing ||
      tab.saveState === 'saving' ||
      tab.version === null ||
      tab.absolutePath === null ||
      !isDirty(tab)
    ) {
      return
    }

    const requestId = ++this.nextRequestId
    tab.saveRequestId = requestId
    tab.saveState = 'saving'
    const sentBody = tab.draft
    const fullContent = joinEditableContent(tab.frontmatter, sentBody)
    this.render()
    try {
      const result = await this.host.writeWorkspaceFile(
        tab.rootPath,
        tab.absolutePath,
        fullContent,
        tab.version,
      )
      if (!this.isCurrentSave(tab, requestId)) return
      const saved = splitEditableContent(result.absolutePath, result.content)
      const draftUnchanged = tab.draft === sentBody
      tab.rootPath = result.rootPath
      tab.relativePath = result.relativePath
      tab.absolutePath = result.absolutePath
      tab.version = result.version
      tab.frontmatter = saved.frontmatter
      tab.originalBody = saved.body
      if (draftUnchanged) tab.draft = saved.body
      tab.saveState = draftUnchanged ? 'saved' : 'idle'
      if (this.activeTabId === tab.id && draftUnchanged) {
        this.editor.setDocument(tab.draft)
      }
    } catch (error) {
      if (!this.isCurrentSave(tab, requestId)) return
      tab.saveState = 'error'
      this.host.onError?.(error)
    } finally {
      if (this.isCurrentSave(tab, requestId)) this.render()
    }
  }

  async cancelActiveEdit(): Promise<boolean> {
    const tab = this.getActiveTab()
    if (
      !tab ||
      tab.loadState !== 'ready' ||
      !tab.editing ||
      tab.saveState === 'saving'
    ) {
      return false
    }
    if (isDirty(tab) && !(await this.confirmDiscard(tab))) return false
    tab.saveRequestId = ++this.nextRequestId
    tab.editing = false
    tab.draft = tab.originalBody
    tab.saveState = 'idle'
    this.editor.setDocument(tab.draft)
    this.editor.setEditable(false)
    this.render()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.nextRequestId += 1
    this.tabs.length = 0
    this.activeTabId = null
    this.editor.dispose()
    if (this.visible) {
      this.visible = false
      this.host.onVisibilityChange(false)
    }
    this.container.empty()
  }

  private async closeTab(tabId: number): Promise<boolean> {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.saveState === 'saving') return false
    if (isDirty(tab) && !(await this.confirmDiscard(tab))) return false
    this.removeTabWithoutConfirmation(tabId)
    return true
  }

  private removeTabWithoutConfirmation(tabId: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const [removed] = this.tabs.splice(index, 1)
    removed.readRequestId = ++this.nextRequestId
    removed.saveRequestId = ++this.nextRequestId
    if (this.activeTabId === tabId) {
      const replacement = this.tabs[Math.min(index, this.tabs.length - 1)] ?? null
      this.activeTabId = replacement?.id ?? null
    }
    if (this.tabs.length === 0) this.setVisible(false)
    this.syncEditorToActiveTab()
    this.render()
  }

  private activateTab(tabId: number): void {
    if (this.activeTabId === tabId || !this.tabs.some((tab) => tab.id === tabId)) {
      return
    }
    this.activeTabId = tabId
    this.syncEditorToActiveTab()
    this.render()
  }

  private enterEditMode(tab: FileTabState): void {
    if (tab.loadState !== 'ready') return
    tab.editing = true
    tab.saveState = 'idle'
    this.editor.setDocument(tab.draft)
    this.editor.setEditable(true)
    this.editor.focus()
    this.render()
  }

  private handleEditorChange(document: string): void {
    const tab = this.getActiveTab()
    if (!tab || tab.loadState !== 'ready' || !tab.editing) return
    tab.draft = document
    if (tab.saveState !== 'saving') tab.saveState = 'idle'
    this.render()
  }

  private syncEditorToActiveTab(): void {
    const tab = this.getActiveTab()
    if (!tab || tab.loadState === 'loading') {
      this.editor.setEditable(false)
      this.editor.setDocument('')
      return
    }
    this.editor.setEditable(tab.editing)
    this.editor.setDocument(tab.draft)
  }

  private render(): void {
    this.tabsContainer.empty()
    for (const tab of this.tabs) this.renderTab(tab)
    this.renderActions()
    const active = this.getActiveTab()
    const loading = active?.loadState === 'loading'
    this.loadingStatus.classList.toggle('is-hidden', !loading)
    this.loadingStatus.textContent = loading ? this.labels.loading : ''
    this.panel.classList.toggle('is-empty', this.tabs.length === 0)
  }

  private renderTab(tab: FileTabState): void {
    const tabElement = this.tabsContainer.createDiv({
      cls: `ai-run-pane__file-tab${this.activeTabId === tab.id ? ' is-active' : ''}${isDirty(tab) ? ' is-dirty' : ''}`,
      attr: { role: 'tab', 'aria-selected': String(this.activeTabId === tab.id) },
    })
    const select = tabElement.createEl('button', {
      cls: 'ai-run-pane__file-tab-select',
      attr: { type: 'button', title: tab.absolutePath ?? tab.requestedPath },
    })
    const icon = select.createSpan({ cls: 'ai-run-pane__file-tab-icon' })
    setIcon(icon, 'file')
    select.createSpan({ cls: 'ai-run-pane__file-tab-title', text: tab.title })
    if (isDirty(tab)) select.createSpan({ cls: 'ai-run-pane__file-tab-dirty', text: '•' })
    select.addEventListener('click', () => this.activateTab(tab.id))
    const close = tabElement.createEl('button', {
      cls: 'ai-run-pane__file-tab-close',
      attr: { type: 'button', title: this.labels.close, 'aria-label': this.labels.close },
    })
    close.disabled = tab.saveState === 'saving'
    setIcon(close, 'x')
    close.addEventListener('click', () => {
      void this.closeTab(tab.id)
    })
  }

  private renderActions(): void {
    this.actionsContainer.empty()
    const tab = this.getActiveTab()
    if (!tab || tab.loadState !== 'ready') return
    if (!tab.editing) {
      const edit = this.actionsContainer.createEl('button', {
        cls: 'ai-run-pane__file-edit',
        attr: { type: 'button', title: this.labels.edit, 'aria-label': this.labels.edit },
      })
      setIcon(edit, 'pencil')
      edit.addEventListener('click', () => this.enterEditMode(tab))
      return
    }

    if (tab.saveState === 'saved') {
      this.actionsContainer.createSpan({
        cls: 'ai-run-pane__file-saved',
        text: this.labels.saved,
        attr: { role: 'status' },
      })
    } else if (tab.saveState === 'error') {
      this.actionsContainer.createSpan({
        cls: 'ai-run-pane__file-save-error',
        text: this.labels.saveFailed,
        attr: { role: 'status' },
      })
    }
    const save = this.actionsContainer.createEl('button', {
      cls: 'ai-run-pane__file-save',
      attr: {
        type: 'button',
        title: tab.saveState === 'saving' ? this.labels.saving : this.labels.save,
        'aria-label': this.labels.save,
      },
    })
    save.disabled = !isDirty(tab) || tab.saveState === 'saving'
    setIcon(save, tab.saveState === 'saving' ? 'loader-circle' : 'save')
    save.addEventListener('click', () => {
      void this.saveActiveFile()
    })
    const cancel = this.actionsContainer.createEl('button', {
      cls: 'ai-run-pane__file-cancel',
      attr: {
        type: 'button',
        title: this.labels.cancel,
        'aria-label': this.labels.cancel,
      },
    })
    cancel.disabled = tab.saveState === 'saving'
    setIcon(cancel, 'x')
    cancel.addEventListener('click', () => {
      void this.cancelActiveEdit()
    })
  }

  private async confirmDiscard(tab: FileTabState): Promise<boolean> {
    const path = tab.absolutePath ?? tab.requestedPath
    if (this.host.confirmDiscard) {
      return await this.host.confirmDiscard(path)
    }
    return this.container.ownerDocument.defaultView?.confirm(
      this.labels.discardConfirmation,
    ) ?? false
  }

  private getActiveTab(): FileTabState | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId)
  }

  private isCurrentRead(tab: FileTabState, requestId: number): boolean {
    return (
      !this.disposed &&
      tab.readRequestId === requestId &&
      this.tabs.some((candidate) => candidate === tab)
    )
  }

  private isCurrentSave(tab: FileTabState, requestId: number): boolean {
    return (
      !this.disposed &&
      tab.saveRequestId === requestId &&
      this.tabs.some((candidate) => candidate === tab)
    )
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.host.onVisibilityChange(visible)
  }
}

function isDirty(tab: FileTabState): boolean {
  return tab.editing && tab.draft !== tab.originalBody
}

function getRequestKey(rootPath: string, filePath: string): string {
  return `${rootPath}\0${filePath}`
}

function getPathBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function joinEditableContent(frontmatter: string, body: string): string {
  if (frontmatter.length === 0 || body.length === 0 || /\r?\n$/.test(frontmatter)) {
    return `${frontmatter}${body}`
  }
  const lineBreak = frontmatter.includes('\r\n') ? '\r\n' : '\n'
  return `${frontmatter}${lineBreak}${body}`
}

function splitEditableContent(
  path: string,
  content: string,
): { frontmatter: string; body: string } {
  if (!/\.(?:md|markdown|mdx)$/i.test(path)) {
    return { frontmatter: '', body: content }
  }
  const match = content.match(
    /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/,
  )
  if (!match) return { frontmatter: '', body: content }
  return {
    frontmatter: match[0],
    body: content.slice(match[0].length),
  }
}
