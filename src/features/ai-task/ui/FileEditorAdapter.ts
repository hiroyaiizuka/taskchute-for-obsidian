/**
 * CodeMirror 6 boundary for the AI Runs file panel.
 *
 * The controller and its jsdom tests depend only on FileEditorAdapterLike.
 * CodeMirror itself stays confined to this file so the production view can
 * use Obsidian's bundled CM6 runtime without leaking editor types across the
 * feature.
 */
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  type KeyBinding,
} from '@codemirror/view'

export interface FileEditorOpenOptions {
  document: string
  editable: boolean
  onChange(document: string): void
  onSave(): void
}

/** Minimal editor surface consumed by WorkspaceFileEditorController. */
export interface FileEditorAdapterLike {
  open(container: HTMLElement, options: FileEditorOpenOptions): void
  setDocument(document: string): void
  setEditable(editable: boolean): void
  getDocument(): string
  focus(): void
  dispose(): void
}

export type FileEditorAdapterFactory = () => FileEditorAdapterLike

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: '#d4d4d4',
      backgroundColor: '#1e1e1e',
      fontSize: '13px',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'Menlo, Monaco, "SF Mono", Consolas, monospace',
      lineHeight: '1.5',
    },
    '.cm-content': { padding: '12px 0' },
    '.cm-gutters': {
      color: '#858585',
      backgroundColor: '#1e1e1e',
      border: 'none',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: 'rgba(255, 255, 255, 0.04)',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
)

class CodeMirrorFileEditorAdapter implements FileEditorAdapterLike {
  private view: EditorView | null = null
  private readonly editableCompartment = new Compartment()
  private suppressChange = false
  private disposed = false

  open(container: HTMLElement, options: FileEditorOpenOptions): void {
    if (this.view || this.disposed) return
    const saveBinding: KeyBinding = {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        options.onSave()
        return true
      },
    }
    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged || this.suppressChange) return
      options.onChange(update.state.doc.toString())
    })
    this.view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: options.document,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          editorTheme,
          keymap.of([saveBinding]),
          updateListener,
          this.editableCompartment.of(editableExtensions(options.editable)),
        ],
      }),
    })
  }

  setDocument(document: string): void {
    const view = this.view
    if (!view || view.state.doc.toString() === document) return
    this.suppressChange = true
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: document },
      })
    } finally {
      this.suppressChange = false
    }
  }

  setEditable(editable: boolean): void {
    const view = this.view
    if (!view) return
    view.dispatch({
      effects: this.editableCompartment.reconfigure(editableExtensions(editable)),
    })
  }

  getDocument(): string {
    return this.view?.state.doc.toString() ?? ''
  }

  focus(): void {
    this.view?.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.view?.destroy()
    this.view = null
  }
}

function editableExtensions(editable: boolean) {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]
}

export function createFileEditorAdapter(): FileEditorAdapterLike {
  return new CodeMirrorFileEditorAdapter()
}
