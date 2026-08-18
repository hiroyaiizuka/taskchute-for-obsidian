import { AbstractInputSuggest, App, TFile } from 'obsidian'
import { listFilesInFolder } from '../utils/vaultFiles'
import { getPathSuggestParentFolder } from './pathSuggestUtils'

type ChooseHandler = (path: string) => void

export class FilePathSuggest extends AbstractInputSuggest<TFile> {
  private readonly onChoose: ChooseHandler
  private readonly textInputEl: HTMLInputElement

  constructor(app: App, inputEl: HTMLInputElement, onChoose: ChooseHandler) {
    super(app, inputEl)
    this.textInputEl = inputEl
    this.onChoose = onChoose
  }

  setValue(value: string): void {
    this.textInputEl.value = value
  }

  protected getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase()
    const parentFolder = getPathSuggestParentFolder(query)
    return listFilesInFolder(this.app, parentFolder, { markdownOnly: true, recursive: false })
      .filter((file) => file.path.toLowerCase().includes(lower))
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path)
  }

  selectSuggestion(file: TFile): void {
    this.onChoose(file.path)
    this.close()
  }
}
