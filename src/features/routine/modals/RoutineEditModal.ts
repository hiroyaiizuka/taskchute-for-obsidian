import { App, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian"

import { t } from "../../../i18n"

import {
  RoutineFrontmatter,
  RoutineWeek,
  TaskChutePluginLike,
  RoutineType,
} from "../../../types"
import { TaskValidator } from "../../core/services/TaskValidator"
import {
  getScheduledTime,
  setScheduledTime,
} from "../../../utils/fieldMigration"
import { applyRoutineFrontmatterMerge } from "../utils/RoutineFrontmatterUtils"

interface TaskChuteViewLike {
  reloadTasksAndRestore?(options?: { runBoundaryCheck?: boolean }): unknown
}

const ROUTINE_TYPE_DEFAULTS: Array<{ value: RoutineType; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly (weekday)" },
  { value: "monthly", label: "Monthly (Nth weekday)" },
]

const WEEK_OPTION_DEFAULTS: Array<{ value: RoutineWeek; label: string }> = [
  { value: 1, label: "1st" },
  { value: 2, label: "2nd" },
  { value: 3, label: "3rd" },
  { value: 4, label: "4th" },
  { value: 5, label: "5th" },
  { value: "last", label: "Last" },
]

const DEFAULT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export default class RoutineEditModal extends Modal {
  private readonly plugin: TaskChutePluginLike
  private readonly file: TFile
  private readonly onSaved?: (frontmatter: RoutineFrontmatter) => void

  constructor(
    app: App,
    plugin: TaskChutePluginLike,
    file: TFile,
    onSaved?: (frontmatter: RoutineFrontmatter) => void,
  ) {
    super(app)
    this.plugin = plugin
    this.file = file
    this.onSaved = onSaved
  }

  private tv(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(`routineEdit.${key}`, fallback, vars)
  }

  private getTypeOptions(): Array<{ value: RoutineType; label: string }> {
    return ROUTINE_TYPE_DEFAULTS.map(({ value, label }) => ({
      value,
      label: this.tv(`types.${value}`, label),
    }))
  }

  private getWeekOptions(): Array<{ value: RoutineWeek; label: string }> {
    const keyMap: Record<string, string> = {
      "1": "weekOptions.first",
      "2": "weekOptions.second",
      "3": "weekOptions.third",
      "4": "weekOptions.fourth",
      "5": "weekOptions.fifth",
      last: "weekOptions.last",
    }
    return WEEK_OPTION_DEFAULTS.map(({ value, label }) => {
      const key = keyMap[String(value)] ?? "weekOptions.first"
      return { value, label: this.tv(key, label) }
    })
  }

  private getWeekdayLabels(): string[] {
    const keys = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ] as const
    return keys.map((key, index) =>
      t(
        `routineManager.weekdays.${key}`,
        DEFAULT_DAY_NAMES[index] ?? DEFAULT_DAY_NAMES[0],
      ),
    )
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    this.modalEl?.classList.add("routine-edit-modal")

    const frontmatter = this.getFrontmatterSnapshot()
    const initialType = this.normalizeRoutineType(frontmatter.routine_type)

    contentEl.createEl("h4", {
      text: this.tv("title", `Routine settings for "${this.file.basename}"`, {
        name: this.file.basename,
      }),
    })

    const form = contentEl.createEl("div", { cls: "routine-form" })

    // Type selector
    const typeGroup = form.createEl("div", { cls: "form-group" })
    typeGroup.createEl("label", {
      text: this.tv("fields.typeLabel", "Type:"),
    })
    const typeSelect = typeGroup.createEl("select")
    this.getTypeOptions().forEach(({ value, label }) => {
      typeSelect.add(new Option(label, value))
    })
    typeSelect.value = initialType

    // Start time
    const timeGroup = form.createEl("div", { cls: "form-group" })
    timeGroup.createEl("label", {
      text: this.tv("fields.startTimeLabel", "Scheduled time:"),
    })
    const timeInput = timeGroup.createEl("input", { type: "time" })
    timeInput.value = getScheduledTime(frontmatter) || ""

    // Interval
    const intervalGroup = form.createEl("div", { cls: "form-group" })
    intervalGroup.createEl("label", {
      text: this.tv("fields.intervalLabel", "Interval:"),
    })
    const intervalInput = intervalGroup.createEl("input", {
      type: "number",
      attr: { min: "1", step: "1" },
    })
    intervalInput.value = String(
      Math.max(1, Number(frontmatter.routine_interval ?? 1)),
    )

    // Enabled toggle
    const enabledGroup = form.createEl("div", {
      cls: "form-group form-group--inline",
    })
    const enabledLabel = enabledGroup.createEl("label", {
      text: this.tv("fields.enabledLabel", "Enabled:"),
    })
    enabledLabel.classList.add("routine-form__inline-label")
    const enabledToggle = enabledGroup.createEl("input", { type: "checkbox" })
    enabledToggle.checked = frontmatter.routine_enabled !== false

    // Start / End dates
    const datesGroup = form.createEl("div", {
      cls: "form-group form-group--date-range",
    })
    datesGroup.createEl("label", {
      text: this.tv("fields.startDateLabel", "Start date:"),
    })
    const startInput = datesGroup.createEl("input", { type: "date" })
    startInput.value =
      typeof frontmatter.routine_start === "string"
        ? frontmatter.routine_start
        : ""
    const endLabel = datesGroup.createEl("label", {
      text: this.tv("fields.endDateLabel", "End date:"),
    })
    endLabel.classList.add(
      "routine-form__inline-label",
      "routine-form__inline-label--gap",
    )
    const endInput = datesGroup.createEl("input", { type: "date" })
    endInput.value =
      typeof frontmatter.routine_end === "string" ? frontmatter.routine_end : ""

    // Weekly controls
    const weeklyGroup = form.createEl("div", {
      cls: "form-group routine-form__weekly routine-chip-panel",
      attr: { "data-kind": "weekly" },
    })
    const weekdayLabels = this.getWeekdayLabels()
    const weekdayInputs = this.createChipFieldset(
      weeklyGroup,
      this.tv("fields.weekdaysLabel", "Weekdays (multi-select):"),
      weekdayLabels.map((label, index) => ({ value: String(index), label })),
    )
    this.applyWeeklySelection(weekdayInputs, frontmatter)

    // Monthly controls
    const monthlyLabel = form.createEl("label", {
      text: this.tv("fields.monthlySettings", "Monthly settings:"),
      cls: "form-label routine-monthly-group__heading",
    })
    monthlyLabel.classList.add("is-hidden")
    const monthlyGroup = form.createEl("div", {
      cls: "form-group routine-form__monthly routine-chip-panel",
      attr: { "data-kind": "monthly" },
    })
    const weekOptions = this.getWeekOptions()
    const monthlyWeekInputs = this.createChipFieldset(
      monthlyGroup,
      this.tv("fields.monthWeeksLabel", "Weeks (multi-select):"),
      weekOptions.map(({ value, label }) => ({
        value: value === "last" ? "last" : String(value),
        label,
      })),
    )

    const monthlyWeekdayInputs = this.createChipFieldset(
      monthlyGroup,
      this.tv("fields.monthWeekdaysLabel", "Weekdays (multi-select):"),
      weekdayLabels.map((label, index) => ({ value: String(index), label })),
    )

    this.applyMonthlySelection(
      monthlyWeekInputs,
      monthlyWeekdayInputs,
      frontmatter,
    )

    const updateVisibility = () => {
      const selected = this.normalizeRoutineType(typeSelect.value)
      const isWeekly = selected === "weekly"
      const isMonthly = selected === "monthly"
      weeklyGroup.classList.toggle("is-hidden", !isWeekly)
      monthlyLabel.classList.toggle("is-hidden", !isMonthly)
      monthlyGroup.classList.toggle("is-hidden", !isMonthly)
    }
    updateVisibility()
    typeSelect.addEventListener("change", updateVisibility)

    // Buttons
    const buttonRow = contentEl.createEl("div", {
      cls: "routine-editor__buttons",
    })
    const saveButton = buttonRow.createEl("button", {
      text: this.tv("fields.saveButton", "Save"),
    })
    saveButton.classList.add(
      "routine-editor__button",
      "routine-editor__button--primary",
    )
    const cancelButton = buttonRow.createEl("button", {
      text: this.tv("fields.cancelButton", "Cancel"),
    })
    cancelButton.classList.add("routine-editor__button")

    saveButton.addEventListener("click", () => {
      void (async () => {
        const errors: string[] = []
        const routineType = this.normalizeRoutineType(typeSelect.value)
        const interval = Math.max(1, Number(intervalInput.value || 1))
        if (!Number.isFinite(interval) || interval < 1) {
          errors.push(
            this.tv(
              "errors.intervalInvalid",
              "Interval must be an integer of 1 or greater.",
            ),
          )
        }

        const start = (startInput.value || "").trim()
        const end = (endInput.value || "").trim()
        const isDate = (value: string) =>
          !value || /^\d{4}-\d{2}-\d{2}$/.test(value)
        if (!isDate(start)) {
          errors.push(
            this.tv(
              "errors.startDateFormat",
              "Start date must use YYYY-MM-DD format.",
            ),
          )
        }
        if (!isDate(end)) {
          errors.push(
            this.tv(
              "errors.endDateFormat",
              "End date must use YYYY-MM-DD format.",
            ),
          )
        }
        if (start && end && start > end) {
          errors.push(
            this.tv(
              "errors.endBeforeStart",
              "End date must be on or after the start date.",
            ),
          )
        }

        const weeklyDays = this.getCheckedDays(weekdayInputs)
        const monthlyWeeks = this.getCheckedWeeks(monthlyWeekInputs)
        const monthlyWeekdays = this.getCheckedDays(monthlyWeekdayInputs)

        if (routineType === "weekly" && weeklyDays.length === 0) {
          errors.push(
            this.tv("errors.weeklyRequiresDay", "Select at least one weekday."),
          )
        } else if (routineType === "monthly") {
          if (monthlyWeeks.length === 0) {
            errors.push(
              this.tv(
                "errors.monthlyRequiresWeek",
                "Select at least one week.",
              ),
            )
          }
          if (monthlyWeekdays.length === 0) {
            errors.push(
              this.tv(
                "errors.monthlyRequiresWeekday",
                "Select at least one weekday.",
              ),
            )
          }
        }

        if (errors.length > 0) {
          new Notice(errors[0])
          return
        }

        let updatedFrontmatter: RoutineFrontmatter | null = null

        await this.app.fileManager.processFrontMatter(
          this.file,
          (fm: RoutineFrontmatter) => {
            // Prepare changes
            const changes: Record<string, unknown> = {
              routine_type: routineType,
              routine_interval: interval,
              routine_enabled: enabledToggle.checked,
            }

            const timeValue = (timeInput.value || "").trim()
            if (timeValue) {
              setScheduledTime(changes, timeValue, { preferNew: true })
            }

            if (start) changes.routine_start = start
            if (end) changes.routine_end = end

            // Apply cleanup to remove target_date if routine settings changed
            // Using record access to check legacy target_date field
            const fmRecord = fm as Record<string, unknown>
            const hadTargetDate = !!fmRecord["target_date"]
            const cleaned = TaskValidator.cleanupOnRoutineChange(fm, changes)
            const hadTemporaryMoveDate = !!fm.temporary_move_date

            applyRoutineFrontmatterMerge(fm, cleaned, {
              hadTargetDate,
              hadTemporaryMoveDate,
            })

            // Notify if target_date was removed
            if (hadTargetDate && !cleaned.target_date) {
              new Notice(
                this.tv(
                  "notices.legacyTargetDateRemoved",
                  "Removed legacy target_date automatically.",
                ),
              )
            }

            // Clean up values that should be removed
            if (!timeValue) setScheduledTime(fm, undefined, { preferNew: true })
            if (!start) delete fm.routine_start
            if (!end) delete fm.routine_end

            delete fm.weekday
            delete fm.weekdays
            delete fm.monthly_week
            delete fm.monthly_weekday
            delete fm.routine_week
            delete fm.routine_weekday

            if (routineType === "weekly") {
              if (weeklyDays.length === 1) {
                fm.routine_weekday = weeklyDays[0]
              } else if (weeklyDays.length > 1) {
                fm.weekdays = weeklyDays
              }
            } else if (routineType === "monthly") {
              const normalizedWeeks = this.normalizeWeekSelection(monthlyWeeks)
              const normalizedWeekdays = monthlyWeekdays

              if (normalizedWeeks.length > 0) {
                fm.routine_weeks = normalizedWeeks
                if (normalizedWeeks.length === 1) {
                  fm.routine_week = normalizedWeeks[0]
                } else {
                  delete fm.routine_week
                }
              } else {
                delete fm.routine_weeks
              }

              if (normalizedWeekdays.length > 0) {
                fm.routine_weekdays = normalizedWeekdays
                if (normalizedWeekdays.length === 1) {
                  fm.routine_weekday = normalizedWeekdays[0]
                } else {
                  delete fm.routine_weekday
                }
              } else {
                delete fm.routine_weekdays
              }
            }

            updatedFrontmatter = { ...fm }
            return fm
          },
        )

        await this.handlePostSave(updatedFrontmatter)
        new Notice(this.tv("notices.saved", "Saved."), 1500)
        this.close()
      })()
    })

    cancelButton.addEventListener("click", () => this.close())
  }

  private getFrontmatterSnapshot(): RoutineFrontmatter {
    const raw = this.app.metadataCache.getFileCache(this.file)?.frontmatter
    if (raw && typeof raw === "object") {
      return { ...(raw as RoutineFrontmatter) }
    }
    return {
      isRoutine: true,
      name: this.file.basename ?? "untitled",
    } as RoutineFrontmatter
  }

  private normalizeRoutineType(type: unknown): RoutineType {
    if (type === "weekly" || type === "monthly") {
      return type
    }
    return "daily"
  }

  private applyWeeklySelection(
    checkboxes: HTMLInputElement[],
    fm: RoutineFrontmatter,
  ): void {
    const selected = this.getWeeklySelection(fm)
    selected.forEach((day) => {
      if (checkboxes[day]) {
        checkboxes[day].checked = true
      }
    })
  }

  private getWeeklySelection(fm: RoutineFrontmatter): number[] {
    if (Array.isArray(fm.weekdays)) {
      return fm.weekdays.filter(
        (day) =>
          Number.isInteger(day) && day >= 0 && day < DEFAULT_DAY_NAMES.length,
      )
    }
    if (typeof fm.routine_weekday === "number") {
      return [fm.routine_weekday]
    }
    if (typeof fm.weekday === "number") {
      return [fm.weekday]
    }
    return []
  }

  private applyMonthlySelection(
    weekInputs: HTMLInputElement[],
    weekdayInputs: HTMLInputElement[],
    fm: RoutineFrontmatter,
  ): void {
    const weekSet = this.normalizeWeekSelection(this.getMonthlyWeekSet(fm))
    if (weekSet.length === 0 && typeof fm.routine_week === "number") {
      weekSet.push(fm.routine_week)
    }
    weekInputs.forEach((input) => {
      input.checked = weekSet.some((week) =>
        week === "last" ? input.value === "last" : input.value === String(week),
      )
    })

    const weekdaySet = this.getMonthlyWeekdaySet(fm)
    weekdayInputs.forEach((input, index) => {
      input.checked = weekdaySet.includes(index)
    })
  }

  private getMonthlyWeekSet(fm: RoutineFrontmatter): Array<RoutineWeek> {
    if (Array.isArray(fm.routine_weeks) && fm.routine_weeks.length) {
      return this.normalizeWeekSelection(fm.routine_weeks)
    }
    if (Array.isArray((fm as Record<string, unknown>).monthly_weeks)) {
      return this.normalizeWeekSelection(
        (fm as Record<string, unknown>).monthly_weeks as RoutineWeek[],
      )
    }
    const single = this.getLegacyMonthlyWeek(fm)
    return single ? [single] : []
  }

  private getLegacyMonthlyWeek(
    fm: RoutineFrontmatter,
  ): RoutineWeek | undefined {
    if (fm.routine_week === "last" || typeof fm.routine_week === "number") {
      return fm.routine_week
    }
    if (fm.monthly_week === "last") {
      return "last"
    }
    if (typeof fm.monthly_week === "number") {
      return (fm.monthly_week + 1) as RoutineWeek
    }
    return undefined
  }

  private getMonthlyWeekdaySet(fm: RoutineFrontmatter): number[] {
    const raw = Array.isArray(fm.routine_weekdays)
      ? fm.routine_weekdays
      : Array.isArray((fm as Record<string, unknown>).monthly_weekdays)
      ? ((fm as Record<string, unknown>).monthly_weekdays as number[])
      : undefined
    if (Array.isArray(raw)) {
      return raw
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
    }
    if (typeof fm.routine_weekday === "number") {
      return [fm.routine_weekday]
    }
    if (typeof fm.monthly_weekday === "number") {
      return [fm.monthly_weekday]
    }
    return []
  }

  private normalizeWeekSelection(
    values: Array<number | "last">,
  ): Array<RoutineWeek> {
    const seen = new Set<string>()
    const result: Array<RoutineWeek> = []
    values.forEach((value) => {
      if (value === "last") {
        if (!seen.has("last")) {
          seen.add("last")
          result.push("last")
        }
        return
      }
      const num = Number(value)
      if (Number.isInteger(num) && num >= 1 && num <= 5) {
        const key = String(num)
        if (!seen.has(key)) {
          seen.add(key)
          result.push(num as RoutineWeek)
        }
      }
    })
    return result
  }

  private createChipFieldset(
    parent: HTMLElement,
    labelText: string,
    options: Array<{ value: string; label: string }>,
  ): HTMLInputElement[] {
    const fieldset = parent.createEl("div", { cls: "routine-chip-fieldset" })
    fieldset.createEl("div", {
      cls: "routine-chip-fieldset__label",
      text: labelText,
    })
    const chipContainer = fieldset.createEl("div", {
      cls: "routine-chip-fieldset__chips",
    })
    return options.map(({ value, label }) => {
      const chip = chipContainer.createEl("label", { cls: "routine-chip" })
      const checkbox = chip.createEl("input", {
        type: "checkbox",
        attr: { value },
      })
      chip.createEl("span", { text: label, cls: "routine-chip__text" })
      return checkbox
    })
  }

  private getCheckedWeeks(
    checkboxes: HTMLInputElement[],
  ): Array<number | "last"> {
    return checkboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) =>
        checkbox.value === "last"
          ? "last"
          : Number.parseInt(checkbox.value, 10),
      )
      .filter(
        (value): value is number | "last" =>
          value === "last" || Number.isInteger(value),
      )
  }

  private getCheckedDays(checkboxes: HTMLInputElement[]): number[] {
    return checkboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => Number.parseInt(checkbox.value, 10))
      .filter((value) => Number.isInteger(value))
  }

  private async handlePostSave(
    updatedFrontmatter: RoutineFrontmatter | null,
  ): Promise<void> {
    if (this.onSaved && updatedFrontmatter) {
      try {
        this.onSaved(updatedFrontmatter)
      } catch (error) {
        console.error("RoutineEditModal onSaved callback failed", error)
      }
    }

    try {
      await this.refreshTaskView()
    } catch (error) {
      console.error("RoutineEditModal failed to refresh view", error)
    }
  }

  private async refreshTaskView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("taskchute-view")
    if (!leaves.length) return

    const leaf = leaves[0] as WorkspaceLeaf | undefined
    const view = leaf?.view as TaskChuteViewLike | undefined
    if (view?.reloadTasksAndRestore) {
      await Promise.resolve(
        view.reloadTasksAndRestore({ runBoundaryCheck: true }),
      )
    }
  }
}
