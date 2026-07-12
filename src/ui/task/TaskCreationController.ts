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
import type { TaskChutePluginLike, TaskNameValidator, DeletedInstance } from "../../types"
import { addMinutesToTime } from "../../utils/date"

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
}

type CreationMode = "reuse" | "copy"

/** Human vs AI task selector state of the add-task modal (U3) */
type TaskType = "human" | "ai"

/** One execution-mode variant of an AI host (ports the reference's variants) */
interface AiExecModeVariant {
  id: string
  labelKey: string
  labelFallback: string
  /** argv tokens the variant contributes to ai_task_args */
  tokens: readonly string[]
}

/**
 * Execution-mode variants per host, mirroring the reference app's
 * commandVariants. The codex "Full auto" flags were re-verified against
 * `codex --help` (0.144.x): the legacy `--full-auto` flag no longer exists;
 * its documented expansion is the approval-policy + sandbox pair below.
 */
const AI_EXEC_MODE_VARIANTS: Record<AiTaskHost, readonly AiExecModeVariant[]> = {
  claude: [
    {
      id: "default",
      labelKey: "addTask.aiExecModeDefault",
      labelFallback: "Normal",
      tokens: [],
    },
    {
      id: "auto",
      labelKey: "addTask.aiExecModeAuto",
      labelFallback: "Auto mode",
      tokens: ["--permission-mode", "auto"],
    },
    {
      id: "skip-permissions",
      labelKey: "addTask.aiExecModeSkipPermissions",
      labelFallback: "Skip permissions",
      tokens: ["--dangerously-skip-permissions"],
    },
  ],
  codex: [
    {
      id: "default",
      labelKey: "addTask.aiExecModeDefault",
      labelFallback: "Normal",
      tokens: [],
    },
    {
      id: "full-auto",
      labelKey: "addTask.aiExecModeFullAuto",
      labelFallback: "Full auto",
      tokens: ["--ask-for-approval", "never", "--sandbox", "workspace-write"],
    },
  ],
}

/** Main-agent cards of the AI mode (only hosts TCO can actually run) */
const AI_AGENT_CARDS: ReadonlyArray<{
  host: AiTaskHost
  icon: string
  labelKey: string
  labelFallback: string
}> = [
  {
    host: "claude",
    icon: "🤖",
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
}

export default class TaskCreationController {
  constructor(private readonly host: TaskCreationControllerHost) {}

  showAddTaskModal(): void {
    const context = this.host.getDocumentContext?.()
    const doc = context?.doc ?? document
    const win = context?.win ?? window

    const modal = createNameModal({
      title: this.host.tv("addTask.title", "Add new task"),
      label: this.host.tv("addTask.nameLabel", "Task name:"),
      placeholder: this.host.tv("addTask.namePlaceholder", "Enter task name"),
      submitText: this.host.tv("buttons.save", "Save"),
      cancelText: t("common.cancel", "Cancel"),
      closeLabel: this.host.tv("common.close", "Close"),
      context: { doc, win },
    })

    const { input: nameInput, inputGroup: nameGroup, warning: warningMessage, submitButton: saveButton, form, close, onClose } = modal
    const buttonGroup = form.querySelector(".form-button-group")

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

    const advancedControls = this.createAdvancedControls(doc)

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
    const aiControls = this.createAiTaskControls(doc, () =>
      syncAiRelatedVisibility(),
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

    const validationControls = this.setupTaskNameValidation(
      nameInput,
      saveButton,
      warningMessage,
    )

    onClose(() => {
      cleanupAutocomplete?.()
      validationControls.dispose()
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
   * and an advanced block (execution mode, AI model, working directory).
   * While reuse mode is active (setReuseActive), the selector and section
   * hide — reference parity with QuestCreateModal's reuse branch.
   * onTaskTypeChange fires whenever the human/AI selection flips so the
   * caller can sync visibility it owns (the human advanced block).
   */
  private createAiTaskControls(
    doc: Document,
    onTaskTypeChange: () => void,
  ): AiTaskControls | null {
    if (
      this.host.plugin.settings.aiTaskEnabled !== true ||
      Platform?.isDesktop !== true
    ) {
      return null
    }

    let taskType: TaskType = "human"
    let selectedHost: AiTaskHost = "claude"
    let reuseActive = false

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

    // Main-agent card grid (Claude Code / Codex).
    const agentField = buildField(
      this.host.tv("addTask.aiAgentLabel", "Main agent"),
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

    // Start time (visible in AI mode regardless of the advanced flag).
    const scheduledField = buildField(
      this.withTrailingColon(this.host.tv("addTask.scheduledTimeLabel", "Start time")),
    )
    const scheduledInput = doc.createElement("input")
    scheduledInput.type = "time"
    scheduledInput.className = "form-input ai-task-scheduled-time"
    scheduledField.appendChild(scheduledInput)

    // Advanced block: execution mode / AI model / working directory.
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
    const modelInput = doc.createElement("input")
    modelInput.type = "text"
    modelInput.className = "form-input ai-task-model-input"
    modelInput.placeholder = this.host.tv("addTask.aiModelPlaceholder", "Default model")
    modelField.appendChild(modelInput)

    const cwdField = buildAdvancedField(
      this.withTrailingColon(
        this.host.tv("addTask.aiCwdLabel", "Working directory"),
      ),
    )
    const cwdInput = doc.createElement("input")
    cwdInput.type = "text"
    cwdInput.className = "form-input ai-task-cwd-input"
    cwdInput.placeholder = this.host.tv(
      "addTask.aiCwdPlaceholder",
      "e.g. /path/to/project",
    )
    cwdField.appendChild(cwdInput)

    // --- Behavior -----------------------------------------------------------
    const currentVariantTokens = (): readonly string[] => {
      const variants = AI_EXEC_MODE_VARIANTS[selectedHost]
      const selected = variants.find((variant) => variant.id === execModeSelect.value)
      return selected?.tokens ?? []
    }

    const buildArgs = (): string[] => {
      const args = [...currentVariantTokens()]
      const model = modelInput.value.trim()
      if (model.length > 0) {
        args.push(`--model=${model}`)
      }
      return args
    }

    const refreshPreview = () => {
      const tokens = [selectedHost as string, ...buildArgs()]
      const sanitizedPrompt = promptInput.value.replace(/\r?\n+/g, " ").trim()
      let text = tokens.join(" ")
      if (sanitizedPrompt.length > 0) {
        const head =
          sanitizedPrompt.length > AI_PREVIEW_PROMPT_HEAD_LIMIT
            ? `${sanitizedPrompt.slice(0, AI_PREVIEW_PROMPT_HEAD_LIMIT)}…`
            : sanitizedPrompt
        text = `${text} "${head}"`
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

    const selectHost = (nextHost: AiTaskHost) => {
      selectedHost = nextHost
      for (const [cardHost, card] of agentCards) {
        const isSelected = cardHost === nextHost
        card.classList.toggle("is-selected", isSelected)
        card.setAttribute("aria-pressed", isSelected ? "true" : "false")
      }
      // The variant set belongs to the host: reset to its default.
      rebuildExecModeOptions()
      refreshPreview()
    }

    const applyVisibility = () => {
      typeGroup.classList.toggle("hidden", reuseActive)
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
      card.addEventListener("click", () => selectHost(cardHost))
    }
    promptInput.addEventListener("input", refreshPreview)
    modelInput.addEventListener("input", refreshPreview)
    execModeSelect.addEventListener("change", refreshPreview)

    selectTaskType("human")
    selectHost("claude")

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
        const cwd = cwdInput.value.trim()
        return {
          host: selectedHost,
          args: buildArgs(),
          cwd: cwd.length > 0 ? cwd : undefined,
          prompt: promptInput.value.trim(),
        }
      },
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
