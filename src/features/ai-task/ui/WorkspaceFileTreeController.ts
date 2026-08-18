import { setIcon } from 'obsidian'
import { WORKSPACE_PATH_DRAG_MIME } from '../services/TerminalPathFormatter'
import type {
  WorkspaceDirectoryListing,
  WorkspaceEntry,
} from '../services/WorkspaceFileService'

export interface WorkspaceFileTreeHost {
  listDirectory(
    rootPath: string,
    directoryPath?: string,
  ): Promise<WorkspaceDirectoryListing>
  loadingLabel: string
  emptyLabel: string
  unavailableLabel: string
  /** Mark a path as originating from this validated Files tree. */
  onPathDragStart(path: string): void
  /** Clear the one-drag provenance after dragend. */
  onPathDragEnd(): void
  /** Open a validated file entry in the AI Runs right-hand editor. */
  onFileActivate(rootPath: string, entry: WorkspaceEntry): void
}

/** Lazy, one-level-at-a-time Files tree. Filesystem reads stay in its host. */
export class WorkspaceFileTreeController {
  private generation = 0
  private currentRootPath: string | undefined | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly host: WorkspaceFileTreeHost,
  ) {}

  showRoot(rootPath: string | undefined): void {
    if (this.currentRootPath === rootPath) return
    this.currentRootPath = rootPath
    this.generation += 1
    const generation = this.generation
    this.container.empty()
    if (!rootPath) {
      this.container.createDiv({
        cls: 'ai-run-pane__files-message',
        text: this.host.unavailableLabel,
      })
      return
    }
    const loading = this.container.createDiv({
      cls: 'ai-run-pane__files-message',
      text: this.host.loadingLabel,
    })
    void this.loadDirectory(rootPath, rootPath, this.container, generation)
      .then((succeeded) => {
        if (!succeeded && generation === this.generation) {
          this.currentRootPath = null
        }
      })
      .finally(() => loading.remove())
  }

  dispose(): void {
    this.currentRootPath = null
    this.generation += 1
    this.container.empty()
  }

  private async loadDirectory(
    rootPath: string,
    directoryPath: string,
    target: HTMLElement,
    generation: number,
  ): Promise<boolean> {
    try {
      const listing = await this.host.listDirectory(rootPath, directoryPath)
      if (generation !== this.generation) return false
      if (listing.entries.length === 0) {
        target.createDiv({
          cls: 'ai-run-pane__files-message',
          text: this.host.emptyLabel,
        })
        return true
      }
      for (const entry of listing.entries) {
        this.renderEntry(rootPath, entry, target, generation)
      }
      return true
    } catch {
      if (generation !== this.generation) return false
      target.createDiv({
        cls: 'ai-run-pane__files-message',
        text: this.host.unavailableLabel,
      })
      return false
    }
  }

  private renderEntry(
    rootPath: string,
    entry: WorkspaceEntry,
    parent: HTMLElement,
    generation: number,
  ): void {
    const wrapper = parent.createDiv({ cls: 'ai-run-pane__file-node' })
    const row = wrapper.createDiv({
      cls:
        entry.type === 'folder'
          ? 'ai-run-pane__file ai-run-pane__file--folder'
          : 'ai-run-pane__file ai-run-pane__file--file',
      attr: {
        role: 'treeitem',
        tabindex: '0',
        'data-path': entry.absolutePath,
        title: entry.absolutePath,
      },
    })
    const icon = row.createSpan({ cls: 'ai-run-pane__file-icon' })
    setIcon(icon, entry.type === 'folder' ? 'chevron-right' : 'file')
    row.createSpan({ cls: 'ai-run-pane__file-name', text: entry.name })

    // Files and folders are both useful terminal arguments. Keep the
    // feature-specific MIME payload identical for both entry types so the
    // terminal drop target can apply one quoting and validation path.
    row.setAttribute('draggable', 'true')
    row.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return
      event.dataTransfer.setData(WORKSPACE_PATH_DRAG_MIME, entry.absolutePath)
      event.dataTransfer.setData('text/plain', entry.absolutePath)
      this.host.onPathDragStart(entry.absolutePath)
    })
    row.addEventListener('dragend', () => this.host.onPathDragEnd())

    if (entry.type === 'file') {
      const activate = (): void => this.host.onFileActivate(rootPath, entry)
      row.addEventListener('click', activate)
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        activate()
      })
      return
    }

    row.setAttribute('aria-expanded', 'false')
    const children = wrapper.createDiv({
      cls: 'ai-run-pane__file-children is-hidden',
      attr: { role: 'group' },
    })
    let loaded = false
    let expanded = false
    const toggle = (): void => {
      expanded = !expanded
      row.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      children.classList.toggle('is-hidden', !expanded)
      setIcon(icon, expanded ? 'chevron-down' : 'chevron-right')
      if (expanded && !loaded) {
        children.empty()
        loaded = true
        void this.loadDirectory(rootPath, entry.relativePath, children, generation).then(
          (succeeded) => {
            if (!succeeded) loaded = false
          },
        )
      }
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }
}
