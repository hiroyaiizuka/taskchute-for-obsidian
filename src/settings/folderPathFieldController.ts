type StoredValue = string | null | undefined

interface TextLike {
  setValue(value: string): unknown
  getValue(): string
}

interface FolderPathFieldControllerOptions {
  text: TextLike
  getStoredValue: (this: void) => StoredValue
  setStoredValue: (this: void, next: StoredValue) => void
  saveSettings: (this: void) => Promise<void>
  validatePath: (this: void, path: string) => { valid: boolean; error?: string }
  folderExists: (this: void, path: string) => boolean
  makeMissingNotice: (this: void, path: string) => string
  notice?: (this: void, message: string) => void
  emptyValue: StoredValue
}

export class FolderPathFieldController {
  private readonly text: TextLike
  private readonly getStoredValue: () => StoredValue
  private readonly setStoredValue: (next: StoredValue) => void
  private readonly saveSettings: () => Promise<void>
  private readonly validatePath: (path: string) => { valid: boolean; error?: string }
  private readonly folderExists: (path: string) => boolean
  private readonly makeMissingNotice: (path: string) => string
  private readonly notice: (message: string) => void
  private readonly emptyValue: StoredValue

  constructor(options: FolderPathFieldControllerOptions) {
    this.text = options.text
    this.getStoredValue = options.getStoredValue
    this.setStoredValue = options.setStoredValue
    this.saveSettings = options.saveSettings
    this.validatePath = options.validatePath
    this.folderExists = options.folderExists
    this.makeMissingNotice = options.makeMissingNotice
    this.notice = options.notice ?? (() => {})
    this.emptyValue = options.emptyValue
  }

  private getCommittedValue(): string {
    const stored = this.getStoredValue()
    if (stored === null || stored === undefined) {
      return ''
    }
    return stored
  }

  private revertToCommitted(): void {
    this.text.setValue(this.getCommittedValue())
  }

  async handleInputChange(raw: string): Promise<void> {
    const trimmed = raw.trim()

    if (!trimmed) {
      this.setStoredValue(this.emptyValue)
      this.text.setValue('')
      await this.saveSettings()
      return
    }

    const validation = this.validatePath(trimmed)
    if (!validation.valid) {
      if (validation.error) {
        this.notice(validation.error)
      }
      this.revertToCommitted()
      return
    }

    this.setStoredValue(trimmed)
    this.text.setValue(trimmed)
    await this.saveSettings()
  }

  handleBlur(): void {
    const stored = this.getStoredValue()
    if (!stored) {
      return
    }

    if (!this.folderExists(stored)) {
      this.notice(this.makeMissingNotice(stored))
    }
  }

  async handleSuggestionSelect(path: string): Promise<void> {
    const trimmed = path.trim()
    this.text.setValue(trimmed)
    await this.handleInputChange(trimmed)
  }
}
