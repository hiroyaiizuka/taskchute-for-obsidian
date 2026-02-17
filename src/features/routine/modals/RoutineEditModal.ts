import { App, Notice, TFile } from "obsidian"

import { t } from "../../../i18n"
import { DATE_FORMAT_DISPLAY } from "../../../constants"

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
import { getToday } from "../../../utils/date"
import { applyRoutineFrontmatterMerge } from "../utils/RoutineFrontmatterUtils"
import { attachCloseButtonIcon } from "../../../ui/components/iconUtils"

interface TaskChuteViewLike {
  reloadTasksAndRestore?(options?: { runBoundaryCheck?: boolean }): unknown
  currentDate?: Date
}

const ROUTINE_TYPE_DEFAULTS: Array<{ value: RoutineType; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly (weekday)" },
  { value: "monthly", label: "Monthly (Nth weekday)" },
  { value: "monthly_date", label: "Monthly (date)" },
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

/**
 * Custom modal implementation that doesn't use Obsidian's Modal class.
 * This allows full control over the close button styling on mobile.
 */
export default class RoutineEditModal {
  private readonly app: App
  private readonly plugin: TaskChutePluginLike
  private readonly file: TFile
  private readonly onSaved?: (frontmatter: RoutineFrontmatter) => void
  private readonly onClosed?: () => void
  private monthdayOutsideClickHandler: ((event: MouseEvent) => void) | null = null
  private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null

  private modalEl: HTMLDivElement | null = null
  private contentEl: HTMLDivElement | null = null

  constructor(
    app: App,
    plugin: TaskChutePluginLike,
    file: TFile,
    onSaved?: (frontmatter: RoutineFrontmatter) => void,
    onClosed?: () => void,
  ) {
    this.app = app
    this.plugin = plugin
    this.file = file
    this.onSaved = onSaved
    this.onClosed = onClosed
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

  open(): void {
    // Create overlay
    this.modalEl = document.createElement("div")
    this.modalEl.className = "task-modal-overlay"

    // Create modal content container
    this.contentEl = this.modalEl.createEl("div", { cls: "task-modal-content routine-edit-modal" })

    // Create header with title and close button
    const header = this.contentEl.createEl("div", { cls: "modal-header" })
    header.createEl("h3", {
      text: this.tv("title", `Routine settings for "${this.file.basename}"`, {
        name: this.file.basename,
      }),
    })
    const closeButton = header.createEl("button", {
      cls: "modal-close-button",
      attr: {
        "aria-label": t("common.close", "Close"),
        type: "button",
      },
    })
    attachCloseButtonIcon(closeButton)
    closeButton.addEventListener("click", () => this.close())

    // Build the form content
    this.buildFormContent()

    // Add to DOM
    document.body.appendChild(this.modalEl)

    // Prevent parent Obsidian Modal focus trap from stealing focus
    // (focusin propagation to document triggers the parent's focus redirect)
    this.modalEl.addEventListener("focusin", (e) => e.stopPropagation())
    this.modalEl.addEventListener("mousedown", (e) => e.stopPropagation())
    this.modalEl.addEventListener("click", (e) => e.stopPropagation())

    // Close on Escape key
    this.escapeKeyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.close()
      }
    }
    document.addEventListener("keydown", this.escapeKeyHandler)
  }

  close(): void {
    // Cleanup event listeners
    if (this.monthdayOutsideClickHandler) {
      document.removeEventListener(
        "click",
        this.monthdayOutsideClickHandler,
        true,
      )
      this.monthdayOutsideClickHandler = null
    }
    if (this.escapeKeyHandler) {
      document.removeEventListener("keydown", this.escapeKeyHandler)
      this.escapeKeyHandler = null
    }

    // Remove from DOM
    if (this.modalEl) {
      this.modalEl.remove()
      this.modalEl = null
      this.contentEl = null
    }

    this.onClosed?.()
  }

  private buildFormContent(): void {
    if (!this.contentEl) return

    const frontmatter = this.getFrontmatterSnapshot()
    const initialType = this.normalizeRoutineType(frontmatter.routine_type)

    const form = this.contentEl.createEl("div", { cls: "routine-form" })

    // Type selector
    const typeGroup = form.createEl("div", { cls: "form-group" })
    typeGroup.createEl("label", {
      text: this.tv("fields.typeLabel", "Type:"),
    })
    const typeSelect = typeGroup.createEl("select", { cls: "form-input" })
    this.getTypeOptions().forEach(({ value, label }) => {
      typeSelect.add(new Option(label, value))
    })
    typeSelect.value = initialType

    // Start time
    const timeGroup = form.createEl("div", { cls: "form-group" })
    timeGroup.createEl("label", {
      text: this.tv("fields.startTimeLabel", "Scheduled time:"),
    })
    const timeInput = timeGroup.createEl("input", { type: "time", cls: "form-input" })
    timeInput.value = getScheduledTime(frontmatter) || ""

    // Prevent touch events from immediately triggering the native time picker
    // when the modal opens (mobile touch event propagation issue)
    // Use disabled attribute which is more reliable than pointer-events
    timeInput.disabled = true
    setTimeout(() => {
      timeInput.disabled = false
    }, 500)

    // Interval
    const intervalGroup = form.createEl("div", { cls: "form-group" })
    intervalGroup.createEl("label", {
      text: this.tv("fields.intervalLabel", "Interval:"),
    })
    const intervalInput = intervalGroup.createEl("input", {
      type: "number",
      cls: "form-input",
      attr: { min: "1", step: "1" },
    })
    intervalInput.value = String(
      Math.max(1, Number(frontmatter.routine_interval ?? 1)),
    )

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

    const monthlyDateGroup = form.createEl("div", {
      cls: "form-group routine-form__monthly-date",
      attr: { "data-kind": "monthly_date" },
    })
    const monthdayLabel = monthlyDateGroup.createEl("label", {
      text: this.tv("fields.monthDaysLabel", "Dates (multi-select):"),
    })
    monthdayLabel.classList.add("routine-form__inline-label")
    const monthdaySelect = monthlyDateGroup.createEl("div", {
      cls: "routine-monthday-select",
    })
    const monthdayTrigger = monthdaySelect.createEl("button", {
      cls: "form-input routine-monthday-trigger",
      attr: {
        type: "button",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
      },
    })
    const monthdayDropdown = monthdaySelect.createEl("div", {
      cls: "routine-monthday-dropdown is-hidden",
    })
    const monthdayOptions = monthdayDropdown.createEl("div", {
      cls: "routine-monthday-options",
    })
    const monthdayCheckboxes: HTMLInputElement[] = []
    for (let day = 1; day <= 31; day += 1) {
      const option = monthdayOptions.createEl("label", {
        cls: "routine-monthday-option",
      })
      const checkbox = option.createEl("input", {
        type: "checkbox",
        attr: { value: String(day) },
      })
      option.createEl("span", {
        text: this.tv("labels.monthdayNth", "{day}", { day }),
        cls: "routine-monthday-option__label",
      })
      monthdayCheckboxes.push(checkbox)
    }
    {
      const option = monthdayOptions.createEl("label", {
        cls: "routine-monthday-option",
      })
      const checkbox = option.createEl("input", {
        type: "checkbox",
        attr: { value: "last" },
      })
      option.createEl("span", {
        text: this.tv("labels.monthdayLast", "Last day"),
        cls: "routine-monthday-option__label",
      })
      monthdayCheckboxes.push(checkbox)
    }
    this.applyMonthlyDateSelection(monthdayCheckboxes, frontmatter)
    const updateMonthdayTrigger = () => {
      const selected = this.normalizeMonthdaySelection(
        this.getCheckedMonthdays(monthdayCheckboxes),
      )
      const label =
        this.formatMonthdayList(selected) ??
        t("taskChuteView.labels.routineMonthdayUnset", "No date set")
      monthdayTrigger.textContent = label
      monthdayTrigger.classList.toggle("is-empty", selected.length === 0)
    }
    updateMonthdayTrigger()
    monthdayCheckboxes.forEach((checkbox) => {
      checkbox.addEventListener("change", updateMonthdayTrigger)
    })
    const openMonthdayDropdown = () => {
      monthdayDropdown.classList.remove("is-hidden")
      monthdayTrigger.setAttribute("aria-expanded", "true")
    }
    const closeMonthdayDropdown = () => {
      monthdayDropdown.classList.add("is-hidden")
      monthdayTrigger.setAttribute("aria-expanded", "false")
    }
    monthdayTrigger.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (monthdayDropdown.classList.contains("is-hidden")) {
        openMonthdayDropdown()
      } else {
        closeMonthdayDropdown()
      }
    })
    const handleMonthdayOutsideClick = (event: MouseEvent) => {
      if (!monthdaySelect.contains(event.target as Node)) {
        closeMonthdayDropdown()
      }
    }
    // Use capture phase so outside-click detection still runs even when
    // modal overlay stops bubbling click events.
    document.addEventListener("click", handleMonthdayOutsideClick, true)
    this.monthdayOutsideClickHandler = handleMonthdayOutsideClick

    const updateVisibility = () => {
      const selected = this.normalizeRoutineType(typeSelect.value)
      const isWeekly = selected === "weekly"
      const isMonthly = selected === "monthly"
      const isMonthlyDate = selected === "monthly_date"
      weeklyGroup.classList.toggle("is-hidden", !isWeekly)
      monthlyLabel.classList.toggle("is-hidden", !isMonthly)
      monthlyGroup.classList.toggle("is-hidden", !isMonthly)
      monthlyDateGroup.classList.toggle("is-hidden", !isMonthlyDate)
      if (!isMonthlyDate) {
        monthdayDropdown.classList.add("is-hidden")
        monthdayTrigger.setAttribute("aria-expanded", "false")
      }
    }
    updateVisibility()
    typeSelect.addEventListener("change", updateVisibility)

    // Buttons
    const buttonRow = this.contentEl.createEl("div", {
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
              `Start date must use ${DATE_FORMAT_DISPLAY} format.`,
            ),
          )
        }
        if (!isDate(end)) {
          errors.push(
            this.tv(
              "errors.endDateFormat",
              `End date must use ${DATE_FORMAT_DISPLAY} format.`,
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
        const monthlyDates = this.getCheckedMonthdays(monthdayCheckboxes)

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
        } else if (routineType === "monthly_date") {
          if (monthlyDates.length === 0) {
            errors.push(
              this.tv(
                "errors.monthlyDateRequiresDay",
                "Select at least one date.",
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
            const targetDate = fmRecord["target_date"]
            const previousTargetDate =
              typeof targetDate === "string" && targetDate.length > 0
                ? targetDate
                : undefined
            const hadTargetDate = previousTargetDate !== undefined
            const wasEnabled = fm.routine_enabled !== false
            const cleaned = TaskValidator.cleanupOnRoutineChange(fm, changes)
            const hadTemporaryMoveDate = !!fm.temporary_move_date

            applyRoutineFrontmatterMerge(fm, cleaned, {
              hadTargetDate,
              hadTemporaryMoveDate,
            })

            // Set target_date when disabling routine (after merge which deletes it)
            if (!enabledToggle.checked) {
              fmRecord['target_date'] =
                wasEnabled || !previousTargetDate
                  ? this.getCurrentViewDateString()
                  : previousTargetDate
            }

            // Notify only when target_date is truly removed from final frontmatter
            const finalTargetDate = fmRecord["target_date"]
            const hasFinalTargetDate =
              typeof finalTargetDate === "string" && finalTargetDate.length > 0
            if (hadTargetDate && !hasFinalTargetDate) {
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
            delete fm.routine_monthday
            delete fm.routine_monthdays

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
            } else if (routineType === "monthly_date") {
              const normalizedMonthdays = this.normalizeMonthdaySelection(
                monthlyDates,
              )
              if (normalizedMonthdays.length > 0) {
                fm.routine_monthdays = normalizedMonthdays
                if (normalizedMonthdays.length === 1) {
                  fm.routine_monthday = normalizedMonthdays[0]
                } else {
                  delete fm.routine_monthday
                }
              } else {
                delete fm.routine_monthdays
                delete fm.routine_monthday
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
    if (type === "weekly" || type === "monthly" || type === "monthly_date") {
      return type
    }
    return "daily"
  }

  private normalizeWeekSelection(weeks: RoutineWeek[]): RoutineWeek[] {
    return weeks.filter(
      (week): week is RoutineWeek =>
        week === "last" ||
        (typeof week === "number" && week >= 1 && week <= 5),
    )
  }

  private normalizeMonthdaySelection(
    days: Array<number | "last">,
  ): Array<number | "last"> {
    return days
      .filter(
        (day): day is number | "last" =>
          day === "last" || (typeof day === "number" && day >= 1 && day <= 31),
      )
      .sort((a, b) => {
        if (a === "last") return 1
        if (b === "last") return -1
        return a - b
      })
  }

  private getCheckedDays(inputs: HTMLInputElement[]): number[] {
    return inputs
      .filter((input) => input.checked)
      .map((input) => parseInt(input.value, 10))
      .filter((value) => !isNaN(value))
  }

  private getCheckedWeeks(inputs: HTMLInputElement[]): RoutineWeek[] {
    return inputs
      .filter((input) => input.checked)
      .map((input) => {
        if (input.value === "last") return "last"
        return parseInt(input.value, 10)
      })
      .filter((value): value is RoutineWeek => value === "last" || !isNaN(value))
  }

  private getCheckedMonthdays(inputs: HTMLInputElement[]): Array<number | "last"> {
    return inputs
      .filter((input) => input.checked)
      .map((input) => {
        if (input.value === "last") return "last"
        return parseInt(input.value, 10)
      })
      .filter((value): value is number | "last" => value === "last" || !isNaN(value))
  }

  private getWeeklySelection(frontmatter: RoutineFrontmatter): number[] {
    const routineWeekday = frontmatter.routine_weekday
    const weekdays = frontmatter.weekdays ?? (frontmatter as Record<string, unknown>).weekdays
    // Legacy: old format used 'weekday' (singular) instead of 'weekdays' or 'routine_weekday'
    const legacyWeekday = (frontmatter as Record<string, unknown>).weekday
    if (Array.isArray(weekdays)) {
      return weekdays.filter((v): v is number => typeof v === "number")
    }
    if (typeof routineWeekday === "number") {
      return [routineWeekday]
    }
    // Fallback to legacy weekday
    if (typeof legacyWeekday === "number") {
      return [legacyWeekday]
    }
    return []
  }

  private getMonthlyWeekSet(frontmatter: RoutineFrontmatter): Set<string> {
    const weeks = frontmatter.routine_weeks
    const week = frontmatter.routine_week
    const legacyWeek = this.getLegacyMonthlyWeek(frontmatter)
    // Legacy: old format used 'monthly_weeks' (plural) array
    const legacyWeeks = (frontmatter as Record<string, unknown>).monthly_weeks
    const result = new Set<string>()
    if (Array.isArray(weeks)) {
      weeks.forEach((w) => result.add(String(w)))
    } else if (Array.isArray(legacyWeeks)) {
      // Fallback to legacy monthly_weeks array
      legacyWeeks.forEach((w) => {
        if (w === "last") {
          result.add("last")
          return
        }
        const asNumber =
          typeof w === "number"
            ? w
            : typeof w === "string" && w.trim() !== ""
              ? Number(w)
              : NaN
        if (Number.isFinite(asNumber)) {
          // Legacy monthly_weeks used 0-based indexing (0..4)
          if (asNumber >= 0 && asNumber <= 4) {
            result.add(String(asNumber + 1))
          } else if (asNumber >= 1 && asNumber <= 5) {
            result.add(String(asNumber))
          }
        }
      })
    } else if (week !== undefined) {
      result.add(String(week))
    } else if (legacyWeek !== undefined) {
      result.add(String(legacyWeek))
    }
    return result
  }

  private getMonthlyWeekdaySet(frontmatter: RoutineFrontmatter): Set<string> {
    const weekdays = frontmatter.routine_weekdays
    const weekday = frontmatter.routine_weekday
    const legacyWeekday = (frontmatter as Record<string, unknown>).monthly_weekday
    const legacyWeekdays = (frontmatter as Record<string, unknown>).monthly_weekdays
    const result = new Set<string>()
    if (Array.isArray(weekdays)) {
      weekdays.forEach((w) => result.add(String(w)))
    } else if (Array.isArray(legacyWeekdays)) {
      legacyWeekdays.forEach((w) => {
        const asNumber =
          typeof w === "number"
            ? w
            : typeof w === "string" && w.trim() !== ""
              ? Number(w)
              : NaN
        if (Number.isFinite(asNumber)) {
          result.add(String(asNumber))
        }
      })
    } else if (weekday !== undefined) {
      result.add(String(weekday))
    } else if (typeof legacyWeekday === "number") {
      result.add(String(legacyWeekday))
    }
    return result
  }

  private getMonthlyMonthday(frontmatter: RoutineFrontmatter): number | "last" | undefined {
    const monthday = frontmatter.routine_monthday
    if (monthday === "last" || (typeof monthday === "number" && monthday >= 1 && monthday <= 31)) {
      return monthday
    }
    return undefined
  }

  private getMonthlyMonthdaySet(frontmatter: RoutineFrontmatter): Set<string> {
    const monthdays = frontmatter.routine_monthdays
    const monthday = this.getMonthlyMonthday(frontmatter)
    const result = new Set<string>()
    if (Array.isArray(monthdays)) {
      monthdays.forEach((d) => result.add(String(d)))
    } else if (monthday !== undefined) {
      result.add(String(monthday))
    }
    return result
  }

  private getLegacyMonthlyWeek(frontmatter: RoutineFrontmatter): RoutineWeek | undefined {
    const record = frontmatter as Record<string, unknown>
    const legacy = record.monthly_week
    if (legacy === "last") return "last"
    if (typeof legacy === "number") {
      // Legacy monthly_week uses 0-based indexing (0..4)
      // Convert to 1-based (1..5) to match current format
      if (legacy >= 0 && legacy <= 4) {
        return (legacy + 1) as RoutineWeek
      }
      // Also accept already-converted 1..5 values for safety
      if (legacy >= 1 && legacy <= 5) {
        return legacy as RoutineWeek
      }
    }
    return undefined
  }

  private createChipFieldset(
    parent: HTMLElement,
    labelText: string,
    options: Array<{ value: string; label: string }>,
  ): HTMLInputElement[] {
    const fieldset = parent.createEl("div", { cls: "routine-chip-fieldset" })
    fieldset.createEl("div", { cls: "routine-chip-fieldset__label", text: labelText })
    const chipContainer = fieldset.createEl("div", { cls: "routine-chip-fieldset__chips" })
    return options.map(({ value, label }) => {
      const chip = chipContainer.createEl("label", { cls: "routine-chip" })
      const checkbox = chip.createEl("input", {
        type: "checkbox",
        value,
      })
      chip.createEl("span", { text: label, cls: "routine-chip__text" })
      return checkbox
    })
  }

  private applyWeeklySelection(
    inputs: HTMLInputElement[],
    frontmatter: RoutineFrontmatter,
  ): void {
    const selected = this.getWeeklySelection(frontmatter)
    inputs.forEach((input) => {
      input.checked = selected.includes(parseInt(input.value, 10))
    })
  }

  private applyMonthlySelection(
    weekInputs: HTMLInputElement[],
    weekdayInputs: HTMLInputElement[],
    frontmatter: RoutineFrontmatter,
  ): void {
    const weekSet = this.getMonthlyWeekSet(frontmatter)
    const weekdaySet = this.getMonthlyWeekdaySet(frontmatter)
    weekInputs.forEach((input) => {
      input.checked = weekSet.has(input.value)
    })
    weekdayInputs.forEach((input) => {
      input.checked = weekdaySet.has(input.value)
    })
  }

  private applyMonthlyDateSelection(
    inputs: HTMLInputElement[],
    frontmatter: RoutineFrontmatter,
  ): void {
    const monthdaySet = this.getMonthlyMonthdaySet(frontmatter)
    inputs.forEach((input) => {
      input.checked = monthdaySet.has(input.value)
    })
  }

  private formatMonthdayList(days: Array<number | "last">): string | null {
    if (days.length === 0) return null
    return days
      .map((d) =>
        d === "last"
          ? this.tv("labels.monthdayLast", "Last day")
          : this.tv("labels.monthdayNth", "{day}", { day: d }),
      )
      .join(", ")
  }

  private async handlePostSave(
    updatedFrontmatter: RoutineFrontmatter | null,
  ): Promise<void> {
    if (this.onSaved && updatedFrontmatter) {
      this.onSaved(updatedFrontmatter)
    }
    await this.refreshTaskView()
  }

  private async refreshTaskView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("taskchute-view")
    for (const leaf of leaves) {
      const view = leaf.view as TaskChuteViewLike | undefined
      if (view && typeof view.reloadTasksAndRestore === "function") {
        await view.reloadTasksAndRestore({ runBoundaryCheck: true })
      }
    }
  }

  private getCurrentViewDateString(): string {
    const activeLeaf = this.app.workspace.getMostRecentLeaf?.()
    const activeView = activeLeaf?.view as TaskChuteViewLike | undefined
    const activeDate = activeView?.currentDate
    if (activeDate instanceof Date && !Number.isNaN(activeDate.getTime())) {
      const y = activeDate.getFullYear()
      const m = String(activeDate.getMonth() + 1).padStart(2, "0")
      const d = String(activeDate.getDate()).padStart(2, "0")
      return `${y}-${m}-${d}`
    }

    const leaves = this.app.workspace.getLeavesOfType("taskchute-view")
    const view = leaves[0]?.view as TaskChuteViewLike | undefined
    const currentDate = view?.currentDate
    if (currentDate instanceof Date && !Number.isNaN(currentDate.getTime())) {
      const y = currentDate.getFullYear()
      const m = String(currentDate.getMonth() + 1).padStart(2, "0")
      const d = String(currentDate.getDate()).padStart(2, "0")
      return `${y}-${m}-${d}`
    }
    return getToday()
  }
}
