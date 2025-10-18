import { Notice, App } from "obsidian"
import type { TFile } from "obsidian"
import { t } from "../../i18n"
import { TaskNameAutocomplete } from "../components/TaskNameAutocomplete"
import { createNameModal } from "../components/NameModal"
import type { TaskCreationService } from "../../features/core/services/TaskCreationService"
import type { TaskChutePluginLike, TaskNameValidator } from "../../types"

export interface TaskCreationControllerHost {
  tv: (
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ) => string
  getTaskNameValidator: () => TaskNameValidator
  taskCreationService: TaskCreationService
  registerAutocompleteCleanup: (cleanup: () => void) => void
  reloadTasksAndRestore: (options?: {
    runBoundaryCheck?: boolean
  }) => Promise<void>
  getCurrentDateString: () => string
  app: Pick<App, "metadataCache">
  plugin: TaskChutePluginLike
}

export default class TaskCreationController {
  constructor(private readonly host: TaskCreationControllerHost) {}

  async showAddTaskModal(): Promise<void> {
    const modal = createNameModal({
      title: this.host.tv("addTask.title", "Add new task"),
      label: this.host.tv("addTask.nameLabel", "Task name:"),
      placeholder: this.host.tv("addTask.namePlaceholder", "Enter task name"),
      submitText: this.host.tv("buttons.save", "Save"),
      cancelText: t("common.cancel", "Cancel"),
      closeLabel: this.host.tv("common.close", "Close"),
    })

    const { input: nameInput, inputGroup: nameGroup, warning: warningMessage, submitButton: saveButton, form, close, onClose } = modal

    let cleanupAutocomplete: (() => void) | null = null
    try {
      const autocomplete = new TaskNameAutocomplete(
        this.host.plugin,
        nameInput,
        nameGroup,
        undefined,
      )
      await autocomplete.initialize()
      cleanupAutocomplete = () => {
        if (typeof autocomplete.destroy === "function") {
          autocomplete.destroy()
        }
      }
      this.host.registerAutocompleteCleanup(cleanupAutocomplete)
    } catch (error) {
      console.error(
        "[TaskCreationController] Failed to initialize autocomplete",
        error,
      )
    }

    const validationControls = this.setupTaskNameValidation(
      nameInput,
      saveButton,
      warningMessage,
    )

    onClose(() => {
      cleanupAutocomplete?.()
      validationControls.dispose()
    })

    nameInput.addEventListener("autocomplete-selected", () => {
      validationControls.runValidation()
    })

    nameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return
      event.preventDefault()
      const validation = this.host
        .getTaskNameValidator()
        .validate(nameInput.value)
      if (!validation.isValid) {
        this.highlightWarning(warningMessage)
      }
    })

    form.addEventListener("submit", async (event) => {
      event.preventDefault()
      const taskName = nameInput.value.trim()

      if (!taskName) {
        new Notice(
          this.host.tv("forms.nameRequired", "Please enter a task name"),
        )
        return
      }

      if (!this.validateTaskNameBeforeSubmit(nameInput)) {
        this.highlightWarning(warningMessage)
        validationControls.runValidation()
        return
      }

      const created = await this.createNewTask(taskName, 30)
      if (created) {
        close()
      } else {
        this.highlightWarning(warningMessage)
        validationControls.runValidation()
      }
    })
  }

  private async createNewTask(
    taskName: string,
    estimatedMinutes: number,
  ): Promise<boolean> {
    try {
      const dateStr = this.host.getCurrentDateString()
      const file = await this.host.taskCreationService.createTaskFile(
        taskName,
        dateStr,
      )
      await this.waitForFrontmatter(file)
      await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      return true
    } catch (error) {
      console.error("[TaskCreationController] Failed to create task", error)
      let errorMessage = this.host.tv(
        "notices.taskCreationFailed",
        "Failed to create task",
      )
      const validation = this.host.getTaskNameValidator().validate(taskName)
      if (
        (error instanceof Error &&
          error.message.includes("Invalid characters")) ||
        !validation.isValid
      ) {
        errorMessage = this.host.tv(
          "notices.taskCreationInvalidFilename",
          "Failed to create task: filename contains invalid characters",
        )
      }
      new Notice(errorMessage)
      return false
    }
  }

  private setupTaskNameValidation(
    inputElement: HTMLInputElement,
    submitButton: HTMLButtonElement,
    warningElement: HTMLElement,
  ): { runValidation: () => void; dispose: () => void } {
    let validationTimer: number | null = null

    const runValidation = () => {
      const validation = this.host
        .getTaskNameValidator()
        .validate(inputElement.value)
      this.updateValidationUI(
        inputElement,
        submitButton,
        warningElement,
        validation,
      )
    }

    const onInput = () => {
      if (validationTimer !== null) {
        window.clearTimeout(validationTimer)
      }
      validationTimer = window.setTimeout(() => {
        validationTimer = null
        runValidation()
      }, 150)
    }

    inputElement.addEventListener("input", onInput)

    return {
      runValidation,
      dispose: () => {
        if (validationTimer !== null) {
          window.clearTimeout(validationTimer)
          validationTimer = null
        }
        inputElement.removeEventListener("input", onInput)
      },
    }
  }

  private updateValidationUI(
    inputElement: HTMLInputElement,
    submitButton: HTMLButtonElement,
    warningElement: HTMLElement,
    validation: ReturnType<TaskNameValidator["validate"]>,
  ): void {
    if (validation.isValid) {
      inputElement.classList.remove("error")
      submitButton.disabled = false
      submitButton.classList.remove("disabled")
      warningElement.classList.add("hidden")
      warningElement.textContent = ""
      return
    }

    inputElement.classList.add("error")
    submitButton.disabled = true
    submitButton.classList.add("disabled")
    warningElement.classList.remove("hidden")
    warningElement.textContent = this.host
      .getTaskNameValidator()
      .getErrorMessage(validation.invalidChars)
  }

  private highlightWarning(warningElement: HTMLElement): void {
    warningElement.classList.add("highlight")
    window.setTimeout(() => warningElement.classList.remove("highlight"), 300)
  }

  private validateTaskNameBeforeSubmit(nameInput: HTMLInputElement): boolean {
    const validation = this.host
      .getTaskNameValidator()
      .validate(nameInput.value)
    return validation.isValid
  }

  private async waitForFrontmatter(
    file: TFile,
    timeoutMs = 4000,
  ): Promise<void> {
    const start = Date.now()
    const hasFrontmatter = () => {
      const cache = this.host.app.metadataCache.getFileCache(file)
      return Boolean(cache?.frontmatter)
    }

    if (hasFrontmatter()) {
      return
    }

    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      if (hasFrontmatter()) {
        return
      }
    }
  }
}
