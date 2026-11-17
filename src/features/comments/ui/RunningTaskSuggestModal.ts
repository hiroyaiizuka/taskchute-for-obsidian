import { App, SuggestModal } from 'obsidian'

export interface RunningTaskChoice {
  instanceId: string
  title: string
}

/**
 * Picks which running task a comment is for, when more than one is running
 * (LEV-415). Typing narrows the list by title; Enter picks the top one.
 */
export class RunningTaskSuggestModal extends SuggestModal<RunningTaskChoice> {
  constructor(
    app: App,
    private readonly choices: RunningTaskChoice[],
    placeholder: string,
    private readonly onChoose: (choice: RunningTaskChoice) => void,
  ) {
    super(app)
    this.setPlaceholder(placeholder)
    this.modalEl.addClass('taskchute-running-task-suggest')
  }

  getSuggestions(query: string): RunningTaskChoice[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return this.choices
    return this.choices.filter((choice) => choice.title.toLowerCase().includes(needle))
  }

  renderSuggestion(choice: RunningTaskChoice, el: HTMLElement): void {
    el.createDiv({ text: choice.title })
  }

  onChooseSuggestion(choice: RunningTaskChoice): void {
    this.onChoose(choice)
  }
}
