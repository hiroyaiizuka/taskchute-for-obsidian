import { App, Notice, Platform } from 'obsidian'
import type { TFile } from "obsidian"
import { t } from "../../i18n"
import {
  TaskNameAutocomplete,
  TaskNameSelectionDetail,
  TaskNameSuggestion,
} from "../components/TaskNameAutocomplete"
import { createNameModal } from "../components/NameModal"
import type {
  CreateTaskFileAiTaskOptions,
  TaskCreationService,
} from "../../features/core/services/TaskCreationService"
import type { TaskReuseService } from "../../features/core/services/TaskReuseService"
import { normalizeReminderTime } from "../../features/reminder/services/ReminderFrontmatterService"
import type { AiTaskHost } from "../../features/ai-task/types"
import { buildTerminalArgs } from "../../features/ai-task/services/TerminalArguments"
import type {
  AiTaskEditService,
  AiTaskEditValue,
} from "../../features/ai-task/services/AiTaskEditService"
import {
  AI_MODEL_PRESETS,
  AI_REASONING_BUDGETS,
  buildReasoningArgs,
  getAvailableReasoningModes,
  type AiReasoningBudget,
  type AiReasoningMode,
} from "../../features/ai-task/config/AiTaskAdvancedOptions"
import {
  AI_EXEC_MODE_VARIANTS,
  decodeAiTaskArgs,
} from "../../features/ai-task/config/AiTaskArgsCodec"
import type {
  TaskChutePluginLike,
  TaskNameValidator,
  DeletedInstance,
  TaskInstance,
} from "../../types"
import { addMinutesToTime } from "../../utils/date"
import {
  WorkingDirectoryHistory,
  normalizeDirectoryPath,
  normalizeDirectoryPathForComparison,
} from "../../features/ai-task/services/WorkingDirectoryHistory"
import { ElectronDirectoryPicker } from "../../features/ai-task/services/ElectronDirectoryPicker"
import { WorkingDirectorySelectController } from "../../features/ai-task/ui/WorkingDirectorySelectController"
import {
  AI_MODEL_ID_SAFE_PATTERN,
  AiCustomModelStore,
} from "../../features/ai-task/models/AiCustomModelStore"
import { AiModelSelectController } from "../../features/ai-task/ui/AiModelSelectController"
import type { Recipe, RecipeService } from "../../features/recipe/services/RecipeService"
import { normalizeRecipeReference } from "../../features/recipe/services/RecipeService"

export interface DeletedTaskRestoreCandidate {
  entry: DeletedInstance
  displayTitle: string
  fileExists: boolean
}

export interface CreatedTaskTarget {
  path: string
  instanceId?: string
}

interface TaskCreationAdvancedOptions {
  scheduledTime?: string
  reminderTime?: string | null
  openCalendarAfterCreate?: boolean
}

export interface TaskCreationControllerHost {
  tv: (
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ) => string
  getTaskNameValidator: () => TaskNameValidator
  taskCreationService: TaskCreationService
  aiTaskEditService: AiTaskEditService
  taskReuseService: TaskReuseService
  hasInstanceForPathToday: (path: string) => boolean
  duplicateInstanceForPath: (
    path: string,
    options?: TaskCreationAdvancedOptions,
  ) => Promise<CreatedTaskTarget | null>
  invalidateDayStateCache: (dateKey: string) => void
  registerAutocompleteCleanup: (cleanup: () => void) => void
  reloadTasksAndRestore: (options?: {
    runBoundaryCheck?: boolean
  }) => Promise<void>
  getCurrentDateString: () => string
  app: Pick<App, "metadataCache">
  plugin: TaskChutePluginLike
  getDocumentContext?: () => {
    doc: Document
    win: Window
  }
  findDeletedTaskRestoreCandidate?: (taskName: string) => DeletedTaskRestoreCandidate | null
  restoreDeletedTaskCandidate?: (candidate: DeletedTaskRestoreCandidate) => Promise<boolean>
  openGoogleCalendarExportForCreatedTask?: (target: CreatedTaskTarget) => Promise<void> | void
  getAiTaskDefaultWorkingDirectory?: () => string
  getAiTaskWorkingDirectoryCandidates?: () => string[]
  selectAiTaskDirectory?: (defaultPath?: string) => Promise<string | null>
  recipeService?: RecipeService
}

type CreationMode = "reuse" | "copy"

/** Human vs AI task selector state of the add-task modal (U3) */
type TaskType = "human" | "ai"

/** Main-agent cards of the AI mode (only hosts TCO can actually run) */
const AI_AGENT_CARDS: ReadonlyArray<{
  host: AiTaskHost
  icon: string
  labelKey: string
  labelFallback: string
}> = [
  {
    host: "claude",
    // Reference parity: main-agents.ts gives Claude Code the 👑 icon.
    icon: "👑",
    labelKey: "addTask.aiAgentClaude",
    labelFallback: "Claude Code",
  },
  {
    host: "codex",
    icon: "📜",
    labelKey: "addTask.aiAgentCodex",
    labelFallback: "Codex",
  },
]

/** Longest prompt head shown inside the live command preview */
const AI_PREVIEW_PROMPT_HEAD_LIMIT = 40

/** Quote a preview token for a POSIX shell's double-quoted context. */
function quotePreviewPrompt(value: string): string {
  const escaped = value.replace(/[\\"$`]/g, '\\$&')
  return `"${escaped}"`
}

/** Live view of the AI-mode controls; null when the feature is unavailable */
interface AiTaskControls {
  typeGroup: HTMLElement
  section: HTMLElement
  isAiMode(): boolean
  /**
   * Reuse mode ignores the AI configuration entirely (the reused note keeps
   * its own frontmatter), so — mirroring the reference QuestCreateModal —
   * the type selector and AI section hide while it is active.
   */
  setReuseActive(active: boolean): void
  getScheduledTime(): string | undefined
  getAiTaskOptions(): CreateTaskFileAiTaskOptions
  commit(): void
  destroy(): void
}

interface AiTaskControlsInitialValue {
  host: AiTaskHost
  args: string[]
  cwd?: string
  prompt: string
  scheduledTime?: string
  recipePath?: string
  lockTaskType?: boolean
}

export default class TaskCreationController {
  constructor(private readonly host: TaskCreationControllerHost) {}

  showAddTaskModal(): void {
    this.showTaskModal()
  }

  async showEditAiTaskModal(inst: TaskInstance): Promise<void> {
    const file = inst.task.file
    if (!file) {
      new Notice(
        this.host.tv(
          "aiTask.notices.editFailed",
          "Could not load or save the AI task settings.",
        ),
      )
      return
    }

    try {
      const target = await this.host.aiTaskEditService.load(
        file,
        inst.task.frontmatter,
        inst.task.displayTitle ?? inst.task.name,
      )
      if (!target) throw new Error("The selected note is not an AI task")
      this.showTaskModal(target)
    } catch (error) {
      console.error("[TaskCreationController] Failed to load AI task", error)
      new Notice(
        this.host.tv(
          "aiTask.notices.editFailed",
          "Could not load or save the AI task settings.",
        ),
      )
    }
  }

  private showTaskModal(editTarget?: AiTaskEditValue): void {
    const context = this.host.getDocumentContext?.()
    const doc = context?.doc ?? document
    const win = context?.win ?? window

    const modal = createNameModal({
      title: editTarget
        ? this.host.tv("aiTask.editTitle", "Edit AI task settings")
        : this.host.tv("addTask.title", "Add new task"),
      label: this.host.tv("addTask.nameLabel", "Task name:"),
      placeholder: this.host.tv("addTask.namePlaceholder", "Enter task name"),
      submitText: this.host.tv("buttons.save", "Save"),
      cancelText: t("common.cancel", "Cancel"),
      closeLabel: this.host.tv("common.close", "Close"),
      context: { doc, win },
    })

    const { input: nameInput, inputGroup: nameGroup, warning: warningMessage, submitButton: saveButton, form, close, onClose } = modal
    const buttonGroup = form.querySelector(".form-button-group")
    if (editTarget) {
      nameInput.value = editTarget.taskName
      nameInput.readOnly = true
      nameInput.classList.add("task-name-input--readonly")
    }

    const modeGroup = doc.createElement("div")
    modeGroup.className = "task-mode-group hidden"

    const modeLabel = doc.createElement("div")
    modeLabel.className = "task-mode-label"
    modeLabel.textContent = this.host.tv("addTask.modeLabel", "Mode")
    modeGroup.appendChild(modeLabel)

    const modeOptions = doc.createElement("div")
    modeOptions.className = "task-mode-options"

    const buildModeOption = (
      value: CreationMode,
      labelText: string,
      checked: boolean,
    ) => {
      const wrapper = doc.createElement("label")
      wrapper.className = "task-mode-option"
      const radio = doc.createElement("input")
      radio.type = "radio"
      radio.name = "taskCreationMode"
      radio.value = value
      radio.checked = checked
      const span = doc.createElement("span")
      span.textContent = labelText
      wrapper.appendChild(radio)
      wrapper.appendChild(span)
      return { wrapper, radio }
    }

    const reuseOption = buildModeOption(
      "reuse",
      this.host.tv("addTask.modeReuse", "Reuse existing task"),
      true,
    )
    const copyOption = buildModeOption(
      "copy",
      this.host.tv("addTask.modeCopy", "Create new copy"),
      false,
    )

    modeOptions.appendChild(reuseOption.wrapper)
    modeOptions.appendChild(copyOption.wrapper)
    modeGroup.appendChild(modeOptions)

    const restoreBanner = doc.createElement("div")
    restoreBanner.className = "task-restore-banner hidden"
    const restoreMessage = doc.createElement("div")
    restoreMessage.className = "task-restore-message"
    const restoreButton = doc.createElement("button")
    restoreButton.type = "button"
    restoreButton.className = "task-restore-button"
    restoreButton.textContent = this.host.tv("addTask.restoreButton", "Restore")
    restoreBanner.appendChild(restoreMessage)
    restoreBanner.appendChild(restoreButton)

    const advancedControls = editTarget ? null : this.createAdvancedControls(doc)

    form.insertBefore(restoreBanner, buttonGroup ?? null)
    if (advancedControls) {
      form.insertBefore(advancedControls.root, restoreBanner)
    }
    form.insertBefore(modeGroup, advancedControls?.root ?? restoreBanner)

    // Human/AI task-type selector + AI-mode section, near the top of the
    // modal (right below the name input). Only present while the AI Task
    // feature is enabled on desktop. syncAiRelatedVisibility is assigned its
    // real body further down (after the reuse-state helpers exist); the
    // controls' construction-time callback runs against this no-op.
    let syncAiRelatedVisibility: () => void = () => undefined
    const aiControls = this.createAiTaskControls(
      doc,
      () => syncAiRelatedVisibility(),
      editTarget
        ? {
          host: editTarget.host,
          args: editTarget.args,
          cwd: editTarget.cwd,
          prompt: editTarget.prompt,
          scheduledTime: editTarget.scheduledTime,
          recipePath: editTarget.recipePath,
          lockTaskType: true,
        }
        : undefined,
    )
    if (aiControls) {
      form.insertBefore(aiControls.typeGroup, nameGroup.nextSibling)
      form.insertBefore(aiControls.section, aiControls.typeGroup.nextSibling)
    }

    let selectedSuggestion: TaskNameSuggestion | null = null
    let selectedValue = ""
    let restoreCandidate: DeletedTaskRestoreCandidate | null = null

    const hasReusableSelection = (): boolean =>
      Boolean(
        selectedSuggestion &&
          selectedSuggestion.type === "task" &&
          selectedSuggestion.path,
      )

    const updateModeGroupVisibility = () => {
      if (hasReusableSelection()) {
        modeGroup.classList.remove("hidden")
      } else {
        modeGroup.classList.add("hidden")
        reuseOption.radio.checked = true
      }
      syncAiRelatedVisibility()
    }

    const resolveCreationMode = (): CreationMode => {
      if (!hasReusableSelection()) {
        return "copy"
      }
      return reuseOption.radio.checked ? "reuse" : "copy"
    }

    if (aiControls) {
      syncAiRelatedVisibility = () => {
        const reuseActive = resolveCreationMode() === "reuse"
        aiControls.setReuseActive(reuseActive)
        // The AI section owns the start time while it is visible, so the
        // duplicated human "Start time"/reminder advanced block hides with
        // it (its reminder would otherwise be computed from a time input
        // the AI section overrides — the carried reminder_time bug). Reuse
        // mode consumes the human block's options, so it comes back there.
        advancedControls?.root.classList.toggle(
          "hidden",
          aiControls.isAiMode() && !reuseActive,
        )
      }
      reuseOption.radio.addEventListener("change", () =>
        syncAiRelatedVisibility(),
      )
      copyOption.radio.addEventListener("change", () =>
        syncAiRelatedVisibility(),
      )
      syncAiRelatedVisibility()
    }

    let cleanupAutocomplete: (() => void) | null = null
    if (!editTarget) {
      try {
        const autocomplete = new TaskNameAutocomplete(
          this.host.plugin,
          nameInput,
          nameGroup,
          { doc, win },
        )
        autocomplete.initialize()
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
    }

    const validationControls = this.setupTaskNameValidation(
      nameInput,
      saveButton,
      warningMessage,
    )

    onClose(() => {
      cleanupAutocomplete?.()
      validationControls.dispose()
      aiControls?.destroy()
    })

    nameInput.addEventListener("input", () => {
      if (selectedSuggestion && nameInput.value.trim() !== selectedValue) {
        selectedSuggestion = null
        selectedValue = ""
        updateModeGroupVisibility()
      }
      updateRestoreCandidate()
    })

    nameInput.addEventListener(
      "autocomplete-selected",
      (event: Event & { detail?: TaskNameSelectionDetail }) => {
        const detail = (event as CustomEvent<TaskNameSelectionDetail>).detail
        selectedSuggestion = detail?.suggestion ?? null
        selectedValue = detail?.value ?? detail?.suggestion?.name ?? ""
        validationControls.runValidation()
        updateModeGroupVisibility()
        updateRestoreCandidate()
      },
    )

    nameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return
      }
      event.preventDefault()
      const validation = this.host
        .getTaskNameValidator()
        .validate(nameInput.value)
      if (!validation.isValid) {
        this.highlightWarning(warningMessage)
      }
    })

    form.addEventListener("submit", (event) => {
      void (async () => {
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

        if (editTarget) {
          if (!aiControls) {
            new Notice(
              this.host.tv(
                "aiTask.notices.editFailed",
                "Could not load or save the AI task settings.",
              ),
            )
            return
          }
          saveButton.disabled = true
          try {
            await this.host.aiTaskEditService.save(
              editTarget.file,
              aiControls.getScheduledTime(),
              aiControls.getAiTaskOptions(),
            )
            aiControls.commit()
            await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
            new Notice(
              this.host.tv("aiTask.editSaved", "AI task settings saved"),
            )
            close()
          } catch (error) {
            console.error("[TaskCreationController] Failed to save AI task", error)
            saveButton.disabled = false
            new Notice(
              this.host.tv(
                "aiTask.notices.editFailed",
                "Could not load or save the AI task settings.",
              ),
            )
          }
          return
        }

        const creationMode = resolveCreationMode()
        // Reuse mode ignores the (hidden) AI configuration entirely — the
        // reused note keeps its own frontmatter — so AI mode is effective
        // only when a new note is actually created.
        const aiMode =
          aiControls?.isAiMode() === true && creationMode !== "reuse"
        let advancedOptions: TaskCreationAdvancedOptions | undefined
        if (aiMode) {
          // The AI section is the single schedule source in AI mode; the
          // human advanced block is hidden and contributes nothing (its
          // reminder would be computed from its own, overridden time).
          const aiScheduledTime = aiControls?.getScheduledTime()
          advancedOptions = aiScheduledTime
            ? { scheduledTime: aiScheduledTime }
            : undefined
        } else {
          advancedOptions = advancedControls?.getOptions(creationMode)
        }

        let created = false
        if (
          creationMode === "reuse" &&
          selectedSuggestion?.type === "task" &&
          selectedSuggestion.path
        ) {
          created = await this.reuseExistingTask(selectedSuggestion.path, advancedOptions)
        } else {
          created = await this.createNewTask(
            taskName,
            30,
            advancedOptions,
            aiMode ? aiControls?.getAiTaskOptions() : undefined,
          )
        }
        if (created) {
          if (aiMode) aiControls?.commit()
          close()
        } else {
          this.highlightWarning(warningMessage)
          validationControls.runValidation()
        }
      })()
    })

    const hideRestoreBanner = () => {
      restoreCandidate = null
      restoreBanner.classList.add("hidden")
      restoreButton.disabled = false
      restoreButton.textContent = this.host.tv("addTask.restoreButton", "Restore")
    }

    const updateRestoreCandidate = () => {
      if (editTarget) {
        hideRestoreBanner()
        return
      }
      if (typeof this.host.findDeletedTaskRestoreCandidate !== "function") {
        hideRestoreBanner()
        return
      }
      const candidate = this.host.findDeletedTaskRestoreCandidate(nameInput.value.trim())
      if (!candidate) {
        hideRestoreBanner()
        return
      }
      restoreCandidate = candidate
      restoreMessage.textContent = this.host.tv(
        "addTask.restoreBanner",
        "Deleted task \"{title}\" is available to restore.",
        { title: candidate.displayTitle },
      )
      restoreBanner.classList.remove("hidden")
      restoreButton.disabled = false
      restoreButton.textContent = this.host.tv("addTask.restoreButton", "Restore")
    }

    restoreButton.addEventListener("click", () => {
      void (async () => {
        if (!restoreCandidate || typeof this.host.restoreDeletedTaskCandidate !== "function") {
          return
        }
        restoreButton.disabled = true
        restoreButton.textContent = this.host.tv("addTask.restoreButtonWorking", "Restoring...")
        try {
          const restored = await this.host.restoreDeletedTaskCandidate(restoreCandidate)
          if (restored) {
            await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
            close()
            return
          }
        } catch (error) {
          console.error("[TaskCreationController] restoreDeletedTaskCandidate failed", error)
        }
        restoreButton.disabled = false
        restoreButton.textContent = this.host.tv("addTask.restoreButton", "Restore")
      })()
    })

    updateRestoreCandidate()
  }

  private createAdvancedControls(doc: Document): {
    root: HTMLDetailsElement
    getOptions: (creationMode: CreationMode) => TaskCreationAdvancedOptions | undefined
  } | null {
    if (this.host.plugin.settings.showTaskCreationAdvancedSettings !== true) {
      return null
    }

    const root = doc.createElement("details")
    root.className = "task-creation-advanced"

    const summary = doc.createElement("summary")
    summary.textContent = this.host.tv("addTask.advancedSummary", "Advanced settings")
    root.appendChild(summary)

    const body = doc.createElement("div")
    body.className = "task-creation-advanced-body"
    root.appendChild(body)

    const scheduledGroup = doc.createElement("div")
    scheduledGroup.className = "task-creation-advanced-field"
    const scheduledLabel = doc.createElement("label")
    scheduledLabel.className = "form-label"
    scheduledLabel.textContent = this.withTrailingColon(
      this.host.tv("addTask.scheduledTimeLabel", "Start time"),
    )
    const scheduledInput = doc.createElement("input")
    scheduledInput.type = "time"
    scheduledInput.className = "form-input task-creation-scheduled-time"
    scheduledGroup.appendChild(scheduledLabel)
    scheduledGroup.appendChild(scheduledInput)
    body.appendChild(scheduledGroup)

    const defaultReminderMinutes = this.getDefaultReminderMinutes()
    const reminderRow = doc.createElement("label")
    reminderRow.className = "task-creation-toggle-row task-creation-reminder-row hidden"
    const reminderText = doc.createElement("span")
    reminderText.textContent = this.withTrailingColon(
      this.host.tv("addTask.reminderToggle", "Set reminder"),
    )
    const reminderToggle = doc.createElement("input")
    reminderToggle.type = "checkbox"
    reminderToggle.className = "task-creation-reminder-toggle"
    reminderRow.appendChild(reminderText)
    reminderRow.appendChild(reminderToggle)
    body.appendChild(reminderRow)

    const calendarEnabled = this.host.plugin.settings.googleCalendar?.enabled === true
    const calendarRow = doc.createElement("label")
    calendarRow.className = "task-creation-toggle-row task-creation-calendar-row hidden"
    const calendarText = doc.createElement("span")
    calendarText.textContent = this.withTrailingColon(
      this.host.tv("addTask.calendarToggle", "Register to calendar"),
    )
    const calendarToggle = doc.createElement("input")
    calendarToggle.type = "checkbox"
    calendarToggle.className = "task-creation-calendar-toggle"
    calendarRow.appendChild(calendarText)
    calendarRow.appendChild(calendarToggle)
    if (calendarEnabled) {
      body.appendChild(calendarRow)
    }

    const updateScheduledDependentControls = () => {
      const scheduledTime = normalizeReminderTime(scheduledInput.value)
      if (!scheduledTime) {
        reminderToggle.checked = false
        calendarToggle.checked = false
        reminderRow.classList.add("hidden")
        calendarRow.classList.add("hidden")
        return
      }

      reminderRow.classList.remove("hidden")
      if (calendarEnabled) {
        calendarRow.classList.remove("hidden")
      }
    }

    scheduledInput.addEventListener("input", updateScheduledDependentControls)
    updateScheduledDependentControls()

    return {
      root,
      getOptions: () => {
        const scheduledTime = normalizeReminderTime(scheduledInput.value)
        if (!scheduledTime) {
          return undefined
        }
        const reminderTime = reminderToggle.checked
          ? this.calculateReminderTime(scheduledTime, defaultReminderMinutes)
          : null
        const openCalendarAfterCreate =
          calendarEnabled && calendarToggle.checked
        return {
          scheduledTime,
          reminderTime,
          openCalendarAfterCreate,
        }
      },
    }
  }

  /**
   * Build the human/AI task-type selector and the AI-mode section of the
   * add-task modal (U3, ports the reference QuestCreateModal). Returns null
   * unless the AI Task feature is enabled on desktop — the human modal is
   * byte-identical in that case. The section reveals, in reference order:
   * the main-agent card grid, the prompt textarea with a live command
   * preview (honest interactive argv: binary + args + quoted prompt head),
   * a start-time input (shown regardless of the advanced-settings flag),
   * and an advanced block (execution mode, AI model, reasoning, working directory).
   * While reuse mode is active (setReuseActive), the selector and section
   * hide — reference parity with QuestCreateModal's reuse branch.
   * onTaskTypeChange fires whenever the human/AI selection flips so the
   * caller can sync visibility it owns (the human advanced block).
   */
  private createAiTaskControls(
    doc: Document,
    onTaskTypeChange: () => void,
    initialValue?: AiTaskControlsInitialValue,
  ): AiTaskControls | null {
    if (
      this.host.plugin.settings.aiTaskEnabled !== true ||
      Platform?.isDesktop !== true
    ) {
      return null
    }

    let taskType: TaskType = initialValue ? "ai" : "human"
    let selectedHost: AiTaskHost = initialValue?.host ?? "claude"
    let reuseActive = false
    const storageApp = this.host.plugin.app as unknown as {
      loadLocalStorage?: (key: string) => unknown
      saveLocalStorage?: (key: string, value: unknown) => void
    }
    const customModelStore = new AiCustomModelStore({
      loadLocalStorage: (key) => storageApp.loadLocalStorage?.(key),
      saveLocalStorage: (key, value) =>
        storageApp.saveLocalStorage?.(key, value),
    })
    const decodedInitialArgs = initialValue
      ? decodeAiTaskArgs(
        initialValue.host,
        initialValue.args,
        (modelId) =>
          AI_MODEL_PRESETS[initialValue.host].some(
            (model) => model.id === modelId,
          ) || customModelStore.hasModelId(initialValue.host, modelId),
      )
      : null
    let passthroughArgs = [...(decodedInitialArgs?.passthroughArgs ?? [])]
    const initialModelIsCustom = Boolean(
      decodedInitialArgs?.modelId &&
        customModelStore
          .getCustomModels(selectedHost)
          .some((model) => model.id === decodedInitialArgs.modelId),
    )

    // --- Task-type selector -------------------------------------------------
    const typeGroup = doc.createElement("div")
    typeGroup.className = "task-type-group"
    const typeLabel = doc.createElement("div")
    typeLabel.className = "task-type-label"
    typeLabel.textContent = this.host.tv("addTask.typeLabel", "Task type")
    typeGroup.appendChild(typeLabel)
    const typeOptions = doc.createElement("div")
    typeOptions.className = "task-type-options"
    typeGroup.appendChild(typeOptions)

    const buildTypeButton = (value: TaskType, labelText: string) => {
      const button = doc.createElement("button")
      button.type = "button"
      button.className = "task-type-option"
      button.dataset.taskType = value
      button.textContent = labelText
      typeOptions.appendChild(button)
      return button
    }
    const humanButton = buildTypeButton(
      "human",
      this.host.tv("addTask.typeHuman", "Human task"),
    )
    const aiButton = buildTypeButton("ai", this.host.tv("addTask.typeAi", "AI task"))

    // --- AI section ---------------------------------------------------------
    const section = doc.createElement("div")
    section.className = "ai-task-section hidden"

    const buildField = (labelText: string): HTMLElement => {
      const field = doc.createElement("div")
      field.className = "ai-task-field"
      const label = doc.createElement("div")
      label.className = "form-label"
      label.textContent = labelText
      field.appendChild(label)
      section.appendChild(field)
      return field
    }

    // Main-agent card grid (Claude Code / Codex). The label leads with the
    // reference's 👑 emoji; the text after an emoji stays lowercase per the
    // obsidianmd sentence-case rule (the emoji counts as the sentence start).
    const agentField = buildField(
      this.host.tv("addTask.aiAgentLabel", "👑 main agent"),
    )
    const agentGrid = doc.createElement("div")
    agentGrid.className = "ai-task-agent-grid"
    agentField.appendChild(agentGrid)
    const agentCards = new Map<AiTaskHost, HTMLButtonElement>()
    for (const cardDef of AI_AGENT_CARDS) {
      const card = doc.createElement("button")
      card.type = "button"
      card.className = "ai-task-agent-card"
      card.dataset.aiHost = cardDef.host
      const icon = doc.createElement("span")
      icon.className = "ai-task-agent-icon"
      icon.textContent = cardDef.icon
      const name = doc.createElement("span")
      name.className = "ai-task-agent-name"
      name.textContent = this.host.tv(cardDef.labelKey, cardDef.labelFallback)
      card.appendChild(icon)
      card.appendChild(name)
      agentGrid.appendChild(card)
      agentCards.set(cardDef.host, card)
    }

    // Prompt textarea + live command preview.
    const promptField = buildField(
      this.host.tv("addTask.aiPromptLabel", "Prompt (optional)"),
    )
    const promptInput = doc.createElement("textarea")
    promptInput.className = "ai-task-prompt-input"
    promptInput.rows = 4
    promptInput.placeholder = this.host.tv(
      "addTask.aiPromptPlaceholder",
      "Review this pull request and point out improvements",
    )
    promptInput.value = initialValue?.prompt ?? ""
    promptField.appendChild(promptInput)
    const preview = doc.createElement("div")
    preview.className = "ai-task-command-preview"
    const previewLabel = doc.createElement("span")
    previewLabel.textContent = this.host.tv(
      "addTask.aiCommandPreviewLabel",
      "Command:",
    )
    const previewCode = doc.createElement("code")
    preview.appendChild(previewLabel)
    preview.appendChild(previewCode)
    promptField.appendChild(preview)

    // Recipe v2 is intentionally outside Advanced settings: it is part of
    // the task request sent to the agent, not a CLI tuning option.
    let recipeSelect: HTMLSelectElement | null = null
    let recipeDetails: HTMLDetailsElement | null = null
    let recipeLoadDisposed = false
    const initialRecipePath = normalizeRecipeReference(initialValue?.recipePath)
    const recipesByPath = new Map<string, Recipe>()
    if (
      this.host.plugin.settings.recipeFeatureEnabled === true &&
      this.host.recipeService
    ) {
      const recipeField = buildField(
        this.host.tv("addTask.aiRecipeLabel", "レシピ（任意）"),
      )
      recipeSelect = doc.createElement("select")
      recipeSelect.className = "form-input ai-task-recipe-select"
      const noneOption = doc.createElement("option")
      noneOption.value = ""
      noneOption.textContent = this.host.tv(
        "addTask.aiRecipeNone",
        "レシピなし",
      )
      recipeSelect.appendChild(noneOption)
      let pendingInitialOption: HTMLOptionElement | null = null
      if (initialRecipePath) {
        pendingInitialOption = doc.createElement("option")
        pendingInitialOption.value = initialRecipePath
        pendingInitialOption.textContent = initialRecipePath
        recipeSelect.appendChild(pendingInitialOption)
        recipeSelect.value = initialRecipePath
      }
      recipeField.appendChild(recipeSelect)

      const disclosure = doc.createElement("div")
      disclosure.className = "ai-task-field-description"
      disclosure.textContent = this.host.tv(
        "addTask.aiRecipeDisclosure",
        "選択したレシピの完了基準・手順・品質基準・制約は、実行時にClaude Code/Codexへ送信されます。秘密情報を含めないでください。",
      )
      recipeField.appendChild(disclosure)

      recipeDetails = doc.createElement("details")
      recipeDetails.className = "ai-task-recipe-preview"
      const detailsSummary = doc.createElement("summary")
      detailsSummary.textContent = this.host.tv(
        "addTask.aiRecipePreview",
        "内容を確認",
      )
      recipeDetails.appendChild(detailsSummary)
      const detailsBody = doc.createElement("pre")
      recipeDetails.appendChild(detailsBody)
      recipeDetails.classList.add("hidden")
      recipeField.appendChild(recipeDetails)

      const updateRecipePreview = () => {
        if (!recipeSelect || !recipeDetails) return
        const recipe = recipesByPath.get(recipeSelect.value)
        recipeDetails.classList.toggle("hidden", !recipe)
        detailsBody.textContent = recipe
          ? [
              recipe.goal
                ? `${this.host.tv("recipes.manager.goalLabel", "完了基準")}\n${recipe.goal}`
                : "",
              recipe.steps.length > 0
                ? `${this.host.tv("recipes.manager.stepsLabel", "手順チェックリスト")}\n${recipe.steps.map((item) => `- ${item.text}`).join("\n")}`
                : "",
              recipe.qualityChecks.length > 0
                ? `${this.host.tv("recipes.manager.qualityChecksLabel", "品質基準チェックリスト")}\n${recipe.qualityChecks.map((item) => `- ${item.text}`).join("\n")}`
                : "",
              recipe.constraints.length > 0
                ? `${this.host.tv("recipes.manager.constraintsLabel", "制約・ルール")}\n${recipe.constraints.map((item) => `- ${item.text}`).join("\n")}`
                : "",
            ].filter(Boolean).join("\n\n")
          : ""
      }
      recipeSelect.addEventListener("change", updateRecipePreview)

      void this.host.recipeService.loadRecipes().then((recipes) => {
        if (recipeLoadDisposed || !recipeSelect) return
        pendingInitialOption?.remove()
        pendingInitialOption = null
        for (const recipe of recipes) {
          recipesByPath.set(recipe.path, recipe)
          const option = doc.createElement("option")
          option.value = recipe.path
          const summaryParts = [
            recipe.goal.trim().length > 0
              ? this.host.tv("addTask.aiRecipeHasGoal", "ゴールあり")
              : null,
            `${this.host.tv("recipes.manager.stepsLabel", "手順")} ${recipe.steps.length}`,
            `${this.host.tv("recipes.manager.qualityChecksLabel", "品質")} ${recipe.qualityChecks.length}`,
            `${this.host.tv("recipes.manager.constraintsLabel", "制約")} ${recipe.constraints.length}`,
          ].filter((value): value is string => value !== null)
          option.textContent = `${recipe.title} — ${summaryParts.join(" / ")}`
          recipeSelect.appendChild(option)
        }
        if (
          initialRecipePath &&
          !recipesByPath.has(initialRecipePath)
        ) {
          const broken = doc.createElement("option")
          broken.value = initialRecipePath
          broken.textContent = `${initialRecipePath} (${this.host.tv("addTask.aiRecipeMissing", "見つかりません")})`
          recipeSelect.appendChild(broken)
        }
        recipeSelect.value = initialRecipePath ?? ""
        updateRecipePreview()
      }).catch((error) => {
        console.warn("[TaskCreationController] Failed to load recipes", error)
      })
    }

    // Start time (visible in AI mode regardless of the advanced flag).
    const scheduledField = buildField(
      this.withTrailingColon(this.host.tv("addTask.scheduledTimeLabel", "Start time")),
    )
    const scheduledInput = doc.createElement("input")
    scheduledInput.type = "time"
    scheduledInput.className = "form-input ai-task-scheduled-time"
    scheduledInput.value = initialValue?.scheduledTime ?? ""
    scheduledField.appendChild(scheduledInput)

    // Advanced block: execution mode / model / reasoning / working directory.
    const advanced = doc.createElement("details")
    advanced.className = "ai-task-advanced"
    const advancedSummary = doc.createElement("summary")
    advancedSummary.textContent = this.host.tv(
      "addTask.advancedSummary",
      "Advanced settings",
    )
    advanced.appendChild(advancedSummary)
    const advancedBody = doc.createElement("div")
    advancedBody.className = "ai-task-advanced-body"
    advanced.appendChild(advancedBody)
    section.appendChild(advanced)

    const buildAdvancedField = (labelText: string): HTMLElement => {
      const field = doc.createElement("div")
      field.className = "ai-task-field"
      const label = doc.createElement("div")
      label.className = "form-label"
      label.textContent = labelText
      field.appendChild(label)
      advancedBody.appendChild(field)
      return field
    }

    const execModeField = buildAdvancedField(
      this.withTrailingColon(this.host.tv("addTask.aiExecModeLabel", "Execution mode")),
    )
    const execModeSelect = doc.createElement("select")
    execModeSelect.className = "form-input ai-task-exec-mode"
    execModeField.appendChild(execModeSelect)

    const modelField = buildAdvancedField(
      this.withTrailingColon(this.host.tv("addTask.aiModelLabel", "AI model")),
    )
    const modelSelect = new AiModelSelectController(modelField, {
      doc,
      host: selectedHost,
      modelId: decodedInitialArgs?.modelId || null,
      isCustom: initialModelIsCustom,
      store: customModelStore,
      labels: {
        openMenu: this.host.tv("addTask.aiModelOpen", "Choose AI model"),
        defaultModel: this.host.tv(
          "addTask.aiModelPlaceholder",
          "Default model",
        ),
        defaultDescription: this.host.tv(
          "addTask.aiModelDefaultDescription",
          "Use the model configured by the CLI",
        ),
        builtInModels: this.host.tv(
          "addTask.aiModelBuiltIn",
          "Available models",
        ),
        customModels: this.host.tv(
          "addTask.aiModelCustomModels",
          "Custom models",
        ),
        addCustomModel: this.host.tv(
          "addTask.aiModelAddCustom",
          "Add custom model",
        ),
        editCustomModel: this.host.tv(
          "addTask.aiModelEditCustom",
          "Edit custom model",
        ),
        deleteCustomModel: this.host.tv(
          "addTask.aiModelDeleteCustom",
          "Delete custom model",
        ),
      },
      customModelModalLabels: this.buildCustomModelModalLabels(),
      onChange: () => {
        passthroughArgs = this.removeModelArgs(passthroughArgs)
        rebuildReasoningModeOptions()
        updateReasoningBudgetVisibility()
        refreshPreview()
      },
    })

    const reasoningModeField = buildAdvancedField(
      this.withTrailingColon(
        this.host.tv("addTask.aiReasoningModeLabel", "Reasoning mode"),
      ),
    )
    const reasoningModeSelect = doc.createElement("select")
    reasoningModeSelect.className = "form-input ai-task-reasoning-mode"
    reasoningModeField.appendChild(reasoningModeSelect)

    const reasoningBudgetField = buildAdvancedField(
      this.withTrailingColon(
        this.host.tv(
          "addTask.aiReasoningBudgetLabel",
          "Reasoning budget (effort)",
        ),
      ),
    )
    reasoningBudgetField.classList.add("ai-task-reasoning-budget-field", "hidden")
    const reasoningBudgetSelect = doc.createElement("select")
    reasoningBudgetSelect.className = "form-input ai-task-reasoning-budget"
    reasoningBudgetField.appendChild(reasoningBudgetSelect)
    const reasoningHint = doc.createElement("div")
    reasoningHint.className = "ai-task-field-description"
    reasoningHint.textContent = this.host.tv(
      "addTask.aiReasoningBudgetHint",
      "Controls adaptive reasoning effort, not a fixed token limit.",
    )
    reasoningBudgetField.appendChild(reasoningHint)

    const cwdField = buildAdvancedField(
      this.withTrailingColon(
        this.host.tv("addTask.aiCwdLabel", "📁 working directory"),
      ),
    )
    const workingDirectoryHistory = new WorkingDirectoryHistory({
      loadLocalStorage: (key) => storageApp.loadLocalStorage?.(key),
      saveLocalStorage: (key, value) =>
        storageApp.saveLocalStorage?.(key, value),
    })
    const defaultWorkingDirectory = normalizeDirectoryPath(
      this.host.getAiTaskDefaultWorkingDirectory?.() ??
        this.resolveVaultWorkingDirectory(),
    )
    const electronDirectoryPicker = new ElectronDirectoryPicker()
    const workingDirectorySelect = new WorkingDirectorySelectController(
      cwdField,
      {
        value: initialValue?.cwd,
        defaultDirectory: defaultWorkingDirectory,
        candidateDirectories:
          this.host.getAiTaskWorkingDirectoryCandidates?.() ?? [],
        history: workingDirectoryHistory,
        picker: {
          selectDirectory: (defaultPath) =>
            this.host.selectAiTaskDirectory
              ? this.host.selectAiTaskDirectory(defaultPath)
              : electronDirectoryPicker.selectDirectory(defaultPath),
        },
        labels: {
          browse: this.host.tv(
            "addTask.aiCwdBrowse",
            "Choose working directory",
          ),
          defaultBadge: this.host.tv("addTask.aiCwdDefault", "Default"),
          recentHeader: this.host.tv(
            "addTask.aiCwdRecent",
            "Recently used directories",
          ),
          resetDefault: this.host.tv(
            "addTask.aiCwdReset",
            "Reset to default",
          ),
          placeholder: this.host.tv(
            "addTask.aiCwdPlaceholder",
            "e.g. /path/to/project",
          ),
        },
      },
    )

    // --- Behavior -----------------------------------------------------------
    const currentVariantTokens = (): readonly string[] => {
      const variants = AI_EXEC_MODE_VARIANTS[selectedHost]
      const selected = variants.find((variant) => variant.id === execModeSelect.value)
      return selected?.tokens ?? []
    }

    const buildArgs = (): string[] => {
      const args = [...currentVariantTokens()]
      const model = modelSelect.getValue().modelId ?? ""
      if (model.length > 0 && AI_MODEL_ID_SAFE_PATTERN.test(model)) {
        args.push(`--model=${model}`)
      }
      args.push(
        ...buildReasoningArgs(
          selectedHost,
          reasoningModeSelect.value as AiReasoningMode,
          reasoningBudgetSelect.value,
        ),
      )
      args.push(...passthroughArgs)
      return args
    }

    const refreshPreview = () => {
      const baseArgs = buildArgs()
      const sanitizedPrompt = promptInput.value.replace(/\r?\n+/g, " ").trim()
      let text = [selectedHost as string, ...baseArgs].join(" ")
      if (sanitizedPrompt.length > 0) {
        const head =
          sanitizedPrompt.length > AI_PREVIEW_PROMPT_HEAD_LIMIT
            ? `${sanitizedPrompt.slice(0, AI_PREVIEW_PROMPT_HEAD_LIMIT)}…`
            : sanitizedPrompt
        const previewArgs = buildTerminalArgs(baseArgs, head)
        text = [
          selectedHost as string,
          ...previewArgs.slice(0, -1),
          quotePreviewPrompt(previewArgs[previewArgs.length - 1]),
        ].join(" ")
      }
      previewCode.textContent = text
    }

    const rebuildExecModeOptions = () => {
      while (execModeSelect.firstChild) {
        execModeSelect.removeChild(execModeSelect.firstChild)
      }
      for (const variant of AI_EXEC_MODE_VARIANTS[selectedHost]) {
        const option = doc.createElement("option")
        option.value = variant.id
        option.textContent = this.host.tv(variant.labelKey, variant.labelFallback)
        execModeSelect.appendChild(option)
      }
      execModeSelect.value = "default"
    }

    const reasoningBudgetLabel = (budget: AiReasoningBudget): string => {
      const definitions: Record<
        AiReasoningBudget,
        { key: string; fallback: string }
      > = {
        low: { key: "addTask.aiReasoningLow", fallback: "Low" },
        medium: { key: "addTask.aiReasoningMedium", fallback: "Medium" },
        high: { key: "addTask.aiReasoningHigh", fallback: "High" },
        xhigh: { key: "addTask.aiReasoningXHigh", fallback: "Extra high" },
        max: { key: "addTask.aiReasoningMax", fallback: "Maximum" },
      }
      const definition = definitions[budget]
      return this.host.tv(definition.key, definition.fallback)
    }

    const reasoningModeLabels = (): Record<AiReasoningMode, string> => ({
      automatic: this.host.tv(
        "addTask.aiReasoningModeAutomatic",
        "Automatic (model default)",
      ),
      specified: this.host.tv(
        "addTask.aiReasoningModeSpecified",
        "Specify budget",
      ),
      ultra: this.host.tv(
        selectedHost === "claude"
          ? "addTask.aiReasoningModeClaudeUltra"
          : "addTask.aiReasoningModeCodexUltra",
        selectedHost === "claude"
          ? "Ultracode (parallel workflow)"
          : "Ultra (parallel delegation)",
      ),
    })

    const appendReasoningModeOption = (mode: AiReasoningMode) => {
      const option = doc.createElement("option")
      option.value = mode
      option.textContent = reasoningModeLabels()[mode]
      reasoningModeSelect.appendChild(option)
    }

    const rebuildReasoningModeOptions = (preserveSelection = true) => {
      const previousMode = reasoningModeSelect.value as AiReasoningMode
      reasoningModeSelect.replaceChildren()
      const selectedModel = modelSelect.getValue()
      const modes = getAvailableReasoningModes(
        selectedHost,
        selectedModel.modelId ?? "",
        { isCustomModel: selectedModel.isCustom },
      )
      for (const mode of modes) {
        appendReasoningModeOption(mode)
      }
      reasoningModeSelect.value =
        preserveSelection && modes.some((mode) => mode === previousMode)
          ? previousMode
          : "automatic"
    }

    const rebuildReasoningBudgetOptions = () => {
      reasoningBudgetSelect.replaceChildren()
      for (const budget of AI_REASONING_BUDGETS[selectedHost]) {
        const option = doc.createElement("option")
        option.value = budget
        option.textContent = reasoningBudgetLabel(budget)
        reasoningBudgetSelect.appendChild(option)
      }
      reasoningBudgetSelect.value = "medium"
      reasoningModeSelect.value = "automatic"
      reasoningBudgetField.classList.add("hidden")
    }

    const updateReasoningBudgetVisibility = () => {
      reasoningBudgetField.classList.toggle(
        "hidden",
        reasoningModeSelect.value !== "specified",
      )
    }

    const selectHost = (nextHost: AiTaskHost) => {
      const hostChanged = nextHost !== selectedHost
      selectedHost = nextHost
      for (const [cardHost, card] of agentCards) {
        const isSelected = cardHost === nextHost
        card.classList.toggle("is-selected", isSelected)
        card.setAttribute("aria-pressed", isSelected ? "true" : "false")
      }
      // The variant set belongs to the host: reset to its default.
      rebuildExecModeOptions()
      if (hostChanged) {
        passthroughArgs = []
        modelSelect.setHost(nextHost)
      }
      rebuildReasoningModeOptions(false)
      rebuildReasoningBudgetOptions()
      refreshPreview()
    }

    const applyVisibility = () => {
      typeGroup.classList.toggle(
        "hidden",
        reuseActive || initialValue?.lockTaskType === true,
      )
      section.classList.toggle("hidden", reuseActive || taskType !== "ai")
    }

    const selectTaskType = (nextType: TaskType) => {
      taskType = nextType
      humanButton.classList.toggle("is-selected", nextType === "human")
      humanButton.setAttribute("aria-pressed", nextType === "human" ? "true" : "false")
      aiButton.classList.toggle("is-selected", nextType === "ai")
      aiButton.setAttribute("aria-pressed", nextType === "ai" ? "true" : "false")
      applyVisibility()
      onTaskTypeChange()
    }

    humanButton.addEventListener("click", () => selectTaskType("human"))
    aiButton.addEventListener("click", () => selectTaskType("ai"))
    for (const [cardHost, card] of agentCards) {
      card.addEventListener("click", () => {
        // Clicking the already-selected agent is a no-op. Rebuilding its
        // controls would silently reset execution/model/reasoning choices.
        if (cardHost === selectedHost) return
        selectHost(cardHost)
      })
    }
    promptInput.addEventListener("input", refreshPreview)
    reasoningModeSelect.addEventListener("change", () => {
      passthroughArgs = this.removeReasoningArgs(
        passthroughArgs,
        selectedHost,
      )
      updateReasoningBudgetVisibility()
      refreshPreview()
    })
    reasoningBudgetSelect.addEventListener("change", refreshPreview)
    execModeSelect.addEventListener("change", refreshPreview)

    selectTaskType(initialValue ? "ai" : "human")
    selectHost(initialValue?.host ?? "claude")
    if (decodedInitialArgs) {
      execModeSelect.value = decodedInitialArgs.execModeId
      const modeAvailable = Array.from(reasoningModeSelect.options).some(
        (option) => option.value === decodedInitialArgs.reasoningMode,
      )
      if (!modeAvailable) {
        appendReasoningModeOption(decodedInitialArgs.reasoningMode)
      }
      reasoningModeSelect.value = decodedInitialArgs.reasoningMode
      reasoningBudgetSelect.value = decodedInitialArgs.reasoningBudget
      updateReasoningBudgetVisibility()
      refreshPreview()
    }

    return {
      typeGroup,
      section,
      isAiMode: () => taskType === "ai",
      setReuseActive: (active: boolean) => {
        reuseActive = active
        applyVisibility()
      },
      getScheduledTime: () => normalizeReminderTime(scheduledInput.value) ?? undefined,
      getAiTaskOptions: () => {
        const cwd = normalizeDirectoryPath(workingDirectorySelect.getValue())
        const usesDefault =
          cwd.length > 0 &&
          normalizeDirectoryPathForComparison(cwd) ===
            normalizeDirectoryPathForComparison(defaultWorkingDirectory)
        const prompt = promptInput.value
        const selectedRecipePath = recipeSelect?.value ?? ""
        const recipePath = !recipeSelect
          ? undefined
          : !initialValue
            ? selectedRecipePath || undefined
            : selectedRecipePath === (initialRecipePath ?? "")
              ? undefined
              : selectedRecipePath || null
        return {
          host: selectedHost,
          args: buildArgs(),
          cwd: cwd.length > 0 && !usesDefault ? cwd : undefined,
          prompt: prompt.trim().length > 0 ? prompt : "",
          ...(recipePath !== undefined ? { recipePath } : {}),
        }
      },
      commit: () => {
        workingDirectorySelect.commitHistory()
      },
      destroy: () => {
        recipeLoadDisposed = true
        modelSelect.destroy()
        workingDirectorySelect.destroy()
      },
    }
  }

  /** Remove modal-owned model flags after the user explicitly changes model. */
  private removeModelArgs(args: readonly string[]): string[] {
    const retained: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]
      if (token.startsWith("--model=")) continue
      if (token === "--model") {
        if (index + 1 < args.length) index += 1
        continue
      }
      retained.push(token)
    }
    return retained
  }

  /** Remove modal-owned reasoning flags after the user changes that control. */
  private removeReasoningArgs(
    args: readonly string[],
    host: AiTaskHost,
  ): string[] {
    const retained: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]
      if (host === "claude" && token.startsWith("--effort=")) continue
      if (
        host === "codex" &&
        token === "--config" &&
        index + 1 < args.length &&
        /^model_reasoning_effort=/u.test(args[index + 1])
      ) {
        index += 1
        continue
      }
      retained.push(token)
    }
    return retained
  }

  private resolveVaultWorkingDirectory(): string {
    const adapter = this.host.plugin.app.vault?.adapter as unknown as {
      getBasePath?: () => unknown
    }
    try {
      const value = adapter?.getBasePath?.()
      return typeof value === "string" ? value : ""
    } catch {
      return ""
    }
  }

  private buildCustomModelModalLabels() {
    return {
      addTitle: this.host.tv(
        "addTask.aiCustomModelAddTitle",
        "Add custom model",
      ),
      editTitle: this.host.tv(
        "addTask.aiCustomModelEditTitle",
        "Edit custom model",
      ),
      claudeAgent: "Claude Code",
      codexAgent: "Codex",
      modelId: this.host.tv("addTask.aiCustomModelId", "Model ID"),
      modelIdPlaceholder: this.host.tv(
        "addTask.aiCustomModelIdPlaceholder",
        "provider/model-name",
      ),
      modelIdHelp: this.host.tv(
        "addTask.aiCustomModelIdHelp",
        "Passed to the CLI as --model=<id>",
      ),
      displayName: this.host.tv(
        "addTask.aiCustomModelDisplayName",
        "Display name",
      ),
      displayNamePlaceholder: this.host.tv(
        "addTask.aiCustomModelDisplayNamePlaceholder",
        "My custom model",
      ),
      description: this.host.tv(
        "addTask.aiCustomModelDescription",
        "Description",
      ),
      descriptionPlaceholder: this.host.tv(
        "addTask.aiCustomModelDescriptionPlaceholder",
        "Optional description",
      ),
      commandPreview: this.host.tv(
        "addTask.aiCustomModelCommandPreview",
        "Command preview",
      ),
      cancel: t("common.cancel", "Cancel"),
      add: this.host.tv("addTask.aiCustomModelAdd", "Add"),
      save: this.host.tv("buttons.save", "Save"),
      close: this.host.tv("common.close", "Close"),
      invalidId: this.host.tv(
        "addTask.aiCustomModelInvalidId",
        "Use 1-100 characters: letters, numbers, dot, underscore, colon, slash, or hyphen; start with a letter or number.",
      ),
      duplicateId: this.host.tv(
        "addTask.aiCustomModelDuplicateId",
        "This model ID already exists.",
      ),
      invalidLabel: this.host.tv(
        "addTask.aiCustomModelInvalidLabel",
        "Enter a display name.",
      ),
      invalidDescription: this.host.tv(
        "addTask.aiCustomModelInvalidDescription",
        "The description is invalid.",
      ),
      modelNotFound: this.host.tv(
        "addTask.aiCustomModelNotFound",
        "The custom model no longer exists.",
      ),
    }
  }

  private getDefaultReminderMinutes(): number {
    const value = this.host.plugin.settings.defaultReminderMinutes ?? 5
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 5
  }

  private withTrailingColon(label: string): string {
    const trimmed = label.trimEnd()
    if (trimmed.endsWith(":") || trimmed.endsWith("：")) {
      return trimmed
    }
    return `${trimmed}:`
  }

  private calculateReminderTime(scheduledTime: string, minutesBefore: number): string {
    return addMinutesToTime(scheduledTime, -minutesBefore)
  }

  private async createNewTask(
    taskName: string,
    estimatedMinutes: number,
    options?: TaskCreationAdvancedOptions,
    aiTask?: CreateTaskFileAiTaskOptions,
  ): Promise<boolean> {
    try {
      const dateStr = this.host.getCurrentDateString()
      const hasFrontmatterOptions =
        Boolean(
          options?.scheduledTime || typeof options?.reminderTime === "string",
        ) || aiTask !== undefined
      const file = hasFrontmatterOptions
        ? await this.host.taskCreationService.createTaskFile(
          taskName,
          dateStr,
          options?.scheduledTime,
          {
            reminderTime: typeof options?.reminderTime === "string" ? options.reminderTime : undefined,
            aiTask,
          },
        )
        : await this.host.taskCreationService.createTaskFile(taskName, dateStr)
      await this.waitForFrontmatter(file)
      await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      if (options?.openCalendarAfterCreate && file.path) {
        await this.host.openGoogleCalendarExportForCreatedTask?.({ path: file.path })
      }
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

  private async reuseExistingTask(
    filePath: string,
    options?: TaskCreationAdvancedOptions,
  ): Promise<boolean> {
    try {
      const dateStr = this.host.getCurrentDateString()
      const alreadyVisible = this.host.hasInstanceForPathToday(filePath)
      let target: CreatedTaskTarget | null = null
      if (alreadyVisible) {
        target = await this.host.duplicateInstanceForPath(filePath, options)
      } else {
        const result = await this.host.taskReuseService.reuseTaskAtDate(
          filePath,
          dateStr,
          options
            ? {
              scheduledTime: options.scheduledTime,
              reminderTime: options.reminderTime,
            }
            : undefined,
        )
        target = {
          path: filePath,
          instanceId: result.instanceId,
        }
        this.host.invalidateDayStateCache(dateStr)
      }
      await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      if (options?.openCalendarAfterCreate) {
        await this.host.openGoogleCalendarExportForCreatedTask?.(
          target ?? { path: filePath },
        )
      }
      return true
    } catch (error) {
      console.error("[TaskCreationController] Failed to reuse task", error)
      new Notice(
        this.host.tv("addTask.reuseFailure", "Failed to reuse task"),
      )
      return false
    }
  }

  private setupTaskNameValidation(
    inputElement: HTMLInputElement,
    submitButton: HTMLButtonElement,
    warningElement: HTMLElement,
  ): { runValidation: () => void; dispose: () => void } {
    let validationTimer: number | null = null
    let validationTimerWindow: Window | null = null

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
        const timer = validationTimer
        const timerWindow = validationTimerWindow ?? activeWindow
        validationTimer = null
        validationTimerWindow = null
        timerWindow.clearTimeout(timer)
      }
      const timerWindow = activeWindow
      validationTimerWindow = timerWindow
      validationTimer = timerWindow.setTimeout(() => {
        validationTimer = null
        validationTimerWindow = null
        runValidation()
      }, 150)
    }

    inputElement.addEventListener("input", onInput)

    return {
      runValidation,
      dispose: () => {
        if (validationTimer !== null) {
          const timer = validationTimer
          const timerWindow = validationTimerWindow ?? activeWindow
          validationTimer = null
          validationTimerWindow = null
          timerWindow.clearTimeout(timer)
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
    activeWindow.setTimeout(() => warningElement.classList.remove("highlight"), 300)
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
      await new Promise((resolve) => activeWindow.setTimeout(resolve, 120))
      if (hasFrontmatter()) {
        return
      }
    }
  }
}
