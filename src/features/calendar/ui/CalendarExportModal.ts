import { App, Modal, Notice, Setting } from "obsidian"
import type {
  GoogleCalendarSettings,
  TaskInstance,
} from "../../../types"
import {
  GoogleCalendarService,
  CalendarEventBuildResult,
} from "../services/GoogleCalendarService"
import { createModalFooter } from "../../../ui/components/modalFooter"

export interface CalendarExportModalOptions {
  app: App
  service: GoogleCalendarService
  instance: TaskInstance
  viewDate: Date
  settings: GoogleCalendarSettings
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getDisplayTitle: (inst: TaskInstance) => string
  isRoutine: boolean
  onMoveNonRoutineDate?: (dateKey: string) => Promise<void>
}

export class CalendarExportModal extends Modal {
  private startTimeInput: HTMLInputElement | null = null
  private durationInput: HTMLInputElement | null = null
  private descriptionPreview: HTMLTextAreaElement | null = null
  private endTimeEl: HTMLElement | null = null
  private errorEl: HTMLElement | null = null
  private dateEl: HTMLElement | null = null
  private dateInput: HTMLInputElement | null = null
  private recurrenceEl: HTMLElement | null = null
  private noteBody = ""
  private preview: CalendarEventBuildResult | null = null
  private initialDateKey: string | null = null
  private overrideDateKey: string | null = null

  constructor(private readonly opts: CalendarExportModalOptions) {
    super(opts.app)
  }

  onOpen(): void {
    void this.initialize()
  }

  private async initialize(): Promise<void> {
    const { contentEl } = this
    contentEl.empty()
    this.modalEl.addClass("taskchute-modal", "taskchute-modal--no-close", "taskchute-calendar-export-modal")
    contentEl.addClass("taskchute-calendar-export-body")

    // 標準タイトルをそのまま利用
    this.titleEl.setText(
      this.opts.tv("calendar.export.title", "Register to Google Calendar"),
    )

    this.noteBody = await this.loadNoteBody()

    const displayTitle = this.opts.getDisplayTitle(this.opts.instance)

    new Setting(contentEl)
      .setName(this.opts.tv("calendar.export.task", "Task"))
      .setDesc(displayTitle)

    const dateSetting = new Setting(contentEl)
      .setName(this.opts.tv("calendar.export.date", "Date"))

    if (this.opts.isRoutine) {
      this.dateEl = dateSetting.descEl
      this.dateEl.setText("-")
    } else {
      dateSetting.addText((text) => {
        text.inputEl.type = "date"
        text.setValue(this.formatDateKey(this.opts.viewDate))
        text.onChange(() => {
          const val = text.inputEl.value
          this.overrideDateKey =
            val && /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : null
          void this.updatePreview()
        })
        this.dateInput = text.inputEl
      })
    }

    if (this.opts.isRoutine) {
      const recurrenceSetting = new Setting(contentEl)
        .setName(this.opts.tv("calendar.export.recurrence", "Recurrence"))
        .setDesc(this.opts.tv("calendar.export.recurrenceNone", "Register as a one-time event"))
      this.recurrenceEl = recurrenceSetting.descEl
    }

    new Setting(contentEl)
      .setName(this.opts.tv("calendar.export.startTime", "Start time"))
      .addText((text) => {
        text.setPlaceholder("09:00")
        text.onChange(() => {
          void this.updatePreview()
        })
        this.startTimeInput = text.inputEl
      })

    new Setting(contentEl)
      .setName(this.opts.tv("calendar.export.duration", "Duration (minutes)"))
      .addText((text) => {
        text.inputEl.type = "number"
        text.inputEl.min = "1"
        text.setPlaceholder("60")
        text.onChange(() => {
          void this.updatePreview()
        })
        this.durationInput = text.inputEl
      })

    new Setting(contentEl)
      .setName(this.opts.tv("calendar.export.details", "Description preview"))
      .addTextArea((area) => {
        area.inputEl.rows = 6
        area.setPlaceholder(
          this.opts.tv(
            "calendar.export.detailsPlaceholder",
            "Obsidian path and note body will appear here"
          ),
        )
        area.setDisabled(true)
        this.descriptionPreview = area.inputEl
      })

    this.errorEl = contentEl.createDiv( { cls: "calendar-export-error" })

    createModalFooter(contentEl, [
      {
        text: this.opts.tv("common.cancel", "Cancel"),
        role: "cancel",
        onClick: () => this.close(),
      },
      {
        text: this.opts.tv("calendar.export.open", "Open calendar"),
        role: "primary",
        onClick: () => {
          void this.handleOpen()
        },
      },
    ])

    await this.updatePreview()
  }

  onClose(): void {
    const { contentEl } = this
    contentEl.empty()
  }

  private async loadNoteBody(): Promise<string> {
    try {
      return await this.opts.service.readNoteBody(this.opts.instance)
    } catch (error) {
      console.error("[CalendarExportModal] Failed to load note body", error)
      return ""
    }
  }

  private async updatePreview(): Promise<void> {
    if (!this.startTimeInput || !this.durationInput) return

    try {
      const preview = await this.opts.service.buildEventFromTask(
        this.opts.instance,
        this.opts.settings,
        {
          viewDate: this.opts.viewDate,
          defaultDurationMinutes:
            this.opts.settings.defaultDurationMinutes ?? 60,
          overrideDateKey: this.overrideDateKey ?? undefined,
          overrideStartTime: this.startTimeInput.value || undefined,
          overrideDurationMinutes: this.parseDuration(this.durationInput.value),
          noteBody: this.noteBody,
        },
      )
      this.preview = preview
      if (!this.initialDateKey) {
        this.initialDateKey = preview.dateKey
      }
      this.errorEl?.empty()
      this.applyPreview(preview)
    } catch (error: unknown) {
      this.preview = null
      this.applyError(error)
    }
  }

  private applyPreview(preview: CalendarEventBuildResult): void {
    if (this.startTimeInput && !this.startTimeInput.value) {
      this.startTimeInput.value = preview.startTimeText
    }
    if (this.durationInput && !this.durationInput.value) {
      const minutes = Math.max(
        1,
        Math.round(
          (preview.end.getTime() - preview.start.getTime()) / 60000,
        ),
      )
      this.durationInput.value = String(minutes)
    }
    if (this.endTimeEl) {
      this.endTimeEl.setText(preview.endTimeText)
    }
    if (this.recurrenceEl) {
      const wrap = this.recurrenceEl.parentElement
      if (this.opts.isRoutine && preview.recurrenceRule) {
        this.recurrenceEl.setText(this.getRecurrenceLabel(preview))
        wrap?.removeClass("is-hidden")
      } else {
        this.recurrenceEl.setText("")
        wrap?.addClass("is-hidden")
      }
    }
    if (this.dateInput && !this.overrideDateKey) {
      this.dateInput.value = preview.dateKey
    }
    if (this.dateEl) {
      this.dateEl.setText(preview.dateKey)
    }
    if (this.descriptionPreview) {
      this.descriptionPreview.value = preview.description
    }
  }

  private applyError(error: unknown): void {
    const message =
      error instanceof Error
        ? error.message
        : this.fallbackUnknown()
    if (this.errorEl) {
      this.errorEl.setText(message)
    }
  }

  private handleOpen(): void {
    if (!this.preview) {
      new Notice(
        this.opts.tv(
          "calendar.export.cannotOpen",
          "Cannot create preview. Check start time and duration."
        ),
      )
      return
    }

    if (
      !this.opts.isRoutine &&
      this.overrideDateKey &&
      this.initialDateKey &&
      this.overrideDateKey !== this.initialDateKey &&
      this.opts.onMoveNonRoutineDate
    ) {
      void this.opts.onMoveNonRoutineDate(this.overrideDateKey).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : this.fallbackUnknown()
          console.error(
            "[CalendarExportModal] Failed to move task before export",
            message,
          )
        },
      )
    }

    const url = this.opts.service.buildEventUrl(this.preview)
    this.opts.service.open(url)
    this.close()
    new Notice(
      this.opts.tv(
        "calendar.export.opened",
        "Opened Google Calendar in your browser"
      ),
    )
  }

  private parseDuration(raw: string): number | undefined {
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) return undefined
    return value
  }

  private getRecurrenceLabel(preview: CalendarEventBuildResult): string {
    if (!preview.recurrenceRule) {
      return this.opts.tv(
        "calendar.export.recurrenceNone",
        "Register as a one-time event"
      )
    }

    const rule = preview.recurrenceRule
    if (rule.startsWith("FREQ=DAILY")) {
      return this.opts.tv("calendar.export.recurrenceDaily", "Repeats daily")
    }
    if (rule.startsWith("FREQ=WEEKLY")) {
      const match = rule.match(/BYDAY=([^;]+)/)
      const days = match?.[1]?.split(",") ?? []
      const labels = days.map((d) => this.dayCodeToLabel(d)).join(", ")
      return this.opts.tv(
        "calendar.export.recurrenceWeekly",
        "Repeats weekly: {days}",
        { days: labels || "不明" },
      )
    }
    if (rule.startsWith("FREQ=MONTHLY")) {
      return this.opts.tv("calendar.export.recurrenceMonthly", "Registers as a monthly routine")
    }
    return this.opts.tv("calendar.export.recurrenceOther", "Registers as a recurring event")
  }

  private dayCodeToLabel(code: string): string {
    const map: Record<string, string> = {
      SU: this.opts.tv("labels.weekdays.sundayShort", "Sun"),
      MO: this.opts.tv("labels.weekdays.mondayShort", "Mon"),
      TU: this.opts.tv("labels.weekdays.tuesdayShort", "Tue"),
      WE: this.opts.tv("labels.weekdays.wednesdayShort", "Wed"),
      TH: this.opts.tv("labels.weekdays.thursdayShort", "Thu"),
      FR: this.opts.tv("labels.weekdays.fridayShort", "Fri"),
      SA: this.opts.tv("labels.weekdays.saturdayShort", "Sat"),
    }
    return map[code] ?? code
  }

  private formatDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
  }

  private fallbackUnknown(): string {
    return this.opts.tv("errors.unknown", "Unknown error")
  }
}
