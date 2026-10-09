/**
 * AI Task - what auto mode needs to say, per agent
 *
 * A new folder makes an agent ask once whether to trust it, and the task
 * waits there. In auto mode the add/edit modal offers, for an agent that has
 * an option for it, a checkbox that adds that option to the task (off by
 * default: it also trusts the folder's own config and scripts). For an agent
 * without one, it shows a note that the agent asks once per folder. An agent
 * whose auto mode has limits worth knowing (agent.autoModeNote) gets a note
 * too. Each note can be dismissed and stays dismissed on this device.
 */

import type { ScopedTranslator } from '@/i18n'
import { getAiAgent } from '../agents'
import type { AiTaskHost } from '../types'

export const AI_TRUST_NOTICE_DISMISSED_KEY = 'taskchute-plus.ai-trust-notice-dismissed'

export interface AiTrustFolderStorage {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

export interface AiTrustFolderControlOptions {
  doc: { win: Window }
  tv: ScopedTranslator<'taskChuteView'>
  storage: AiTrustFolderStorage
  /** Called when the checkbox changes, to refresh the command preview. */
  onChange: () => void
}

export class AiTrustFolderControl {
  readonly root: HTMLElement
  private readonly checkboxRow: HTMLElement
  private readonly checkbox: HTMLInputElement
  private readonly trustNotice: DismissibleNote
  private readonly autoNote: DismissibleNote

  constructor(private readonly options: AiTrustFolderControlOptions) {
    const { doc, tv } = options
    this.root = doc.win.createDiv()
    this.root.className = 'ai-task-trust'

    this.checkboxRow = doc.win.createEl('label')
    this.checkboxRow.className = 'ai-task-trust__option'
    this.checkbox = doc.win.createEl('input')
    this.checkbox.type = 'checkbox'
    this.checkbox.className = 'ai-task-trust__checkbox'
    this.checkbox.addEventListener('change', () => options.onChange())
    const text = doc.win.createDiv()
    text.className = 'ai-task-trust__text'
    const label = doc.win.createSpan()
    label.className = 'ai-task-trust__label'
    label.textContent = tv('addTask.aiTrustFolder', 'Trust this folder and start without asking')
    const hint = doc.win.createSpan()
    hint.className = 'ai-task-trust__hint'
    hint.textContent = tv(
      'addTask.aiTrustFolderHint',
      "This also trusts the folder's own settings and scripts. Leave it off for folders you do not know.",
    )
    text.append(label, hint)
    this.checkboxRow.append(this.checkbox, text)

    this.autoNote = this.createNote('ai-task-trust__notice--auto')
    this.trustNotice = this.createNote('ai-task-trust__notice--trust')
    // What auto mode does first, then what it may trust.
    this.root.append(this.autoNote.root, this.checkboxRow, this.trustNotice.root)
  }

  /** Shows what fits the selected agent and mode: the checkbox and notes, or nothing. */
  update(host: AiTaskHost, execModeId: string): void {
    const agent = getAiAgent(host)
    const { tv } = this.options
    const auto = execModeId === 'auto'
    const canTrust = (agent.trustFolderArgs?.length ?? 0) > 0
    this.checkboxRow.classList.toggle('hidden', !(auto && canTrust))
    this.showNote(
      this.autoNote,
      `auto-note:${host}`,
      auto && agent.autoModeNote ? tv(agent.autoModeNote.key, agent.autoModeNote.fallback) : null,
    )
    this.showNote(
      this.trustNotice,
      `trust:${host}`,
      auto && !canTrust
        ? tv(
          'addTask.aiTrustNotice',
          '{agent} asks whether to trust a folder the first time it runs there in the terminal, and waits. Answer once and it will not ask again.',
          { agent: tv(agent.label.key, agent.label.fallback) },
        )
        : null,
    )
    this.root.classList.toggle('hidden', !auto)
  }

  isChecked(): boolean {
    return this.checkbox.checked
  }

  setChecked(checked: boolean): void {
    this.checkbox.checked = checked
  }

  private createNote(modifier: string): DismissibleNote {
    const { doc, tv } = this.options
    const root = doc.win.createDiv()
    root.className = `ai-task-trust__notice ${modifier}`
    root.setAttribute('role', 'note')
    const text = doc.win.createSpan()
    text.className = 'ai-task-trust__notice-text'
    const dismiss = doc.win.createEl('button')
    dismiss.type = 'button'
    dismiss.className = 'clickable-icon ai-task-trust__dismiss'
    dismiss.textContent = '×'
    const dismissLabel = tv('addTask.aiTrustNoticeDismiss', 'Dismiss')
    dismiss.setAttribute('aria-label', dismissLabel)
    dismiss.title = dismissLabel
    const note: DismissibleNote = { root, text, id: '' }
    dismiss.addEventListener('click', () => {
      this.rememberDismissed(note.id)
      root.classList.add('hidden')
    })
    root.append(text, dismiss)
    return note
  }

  /** Shows the note with this text unless it was dismissed on this device; null hides it. */
  private showNote(note: DismissibleNote, id: string, text: string | null): void {
    note.id = id
    const show = text !== null && !this.dismissedIds().includes(id)
    note.root.classList.toggle('hidden', !show)
    if (show) note.text.textContent = text
  }

  private dismissedIds(): string[] {
    try {
      const stored = this.options.storage.loadLocalStorage?.(AI_TRUST_NOTICE_DISMISSED_KEY)
      return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : []
    } catch {
      return []
    }
  }

  private rememberDismissed(id: string): void {
    const ids = this.dismissedIds()
    if (ids.includes(id)) return
    try {
      this.options.storage.saveLocalStorage?.(AI_TRUST_NOTICE_DISMISSED_KEY, [...ids, id])
    } catch {
      // Device-local storage is optional; the note just shows again next time.
    }
  }
}

interface DismissibleNote {
  root: HTMLElement
  text: HTMLElement
  /** What the note says about which agent, so dismissing it hides that one only. */
  id: string
}
