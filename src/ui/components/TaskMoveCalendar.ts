import type { LocaleKey } from "../../i18n"
import { getCurrentLocale, t } from "../../i18n"

interface TaskMoveCalendarOptions {
  anchor: HTMLElement
  initialDate: Date
  today: Date
  onSelect: (isoDate: string) => void | Promise<void>
  onClear?: () => void | Promise<void>
  onClose?: () => void
}

function cloneDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function toISODate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function isSameDate(a: Date | undefined, b: Date | undefined): boolean {
  if (!a || !b) return false
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export class TaskMoveCalendar {
  private readonly anchor: HTMLElement
  private readonly today: Date
  private readonly onSelect: (isoDate: string) => void | Promise<void>
  private readonly onClear?: () => void | Promise<void>
  private readonly onClose?: () => void
  private readonly locale: LocaleKey
  private readonly monthFormatter: Intl.DateTimeFormat
  private readonly weekdayLabels: string[]

  private container: HTMLDivElement | null = null
  private currentMonth: Date
  private selectedDate: Date
  private outsideClickHandler?: (event: MouseEvent) => void

  constructor(options: TaskMoveCalendarOptions) {
    this.anchor = options.anchor
    this.today = cloneDate(options.today)
    this.onSelect = options.onSelect
    this.onClear = options.onClear
    this.onClose = options.onClose

    this.locale = getCurrentLocale()
    this.monthFormatter = new Intl.DateTimeFormat(
      this.locale === "ja" ? "ja-JP" : "en-US",
      {
        year: "numeric",
        month: "long",
      },
    )
    this.weekdayLabels = [
      t('taskChuteView.labels.weekdays.sundayShort', 'Sun'),
      t('taskChuteView.labels.weekdays.mondayShort', 'Mon'),
      t('taskChuteView.labels.weekdays.tuesdayShort', 'Tue'),
      t('taskChuteView.labels.weekdays.wednesdayShort', 'Wed'),
      t('taskChuteView.labels.weekdays.thursdayShort', 'Thu'),
      t('taskChuteView.labels.weekdays.fridayShort', 'Fri'),
      t('taskChuteView.labels.weekdays.saturdayShort', 'Sat'),
    ]

    this.selectedDate = cloneDate(options.initialDate)
    this.currentMonth = new Date(
      this.selectedDate.getFullYear(),
      this.selectedDate.getMonth(),
      1,
    )
  }

  open(): void {
    if (this.container) {
      this.close()
    }

    this.container = document.createElement("div")
    this.container.className = "taskchute-move-calendar"

    this.render()

    document.body.appendChild(this.container)
    this.position()

    this.outsideClickHandler = (event) => {
      if (!this.container) return
      const target = event.target as Node | null
      if (!target) return
      const clickedInsideCalendar = this.container.contains(target)
      const clickedAnchor = this.anchor.contains(target)
      if (!clickedInsideCalendar && !clickedAnchor) {
        this.close()
      }
    }

    // Defer registration to avoid immediately closing due to same click
    setTimeout(() => {
      if (this.outsideClickHandler) {
        document.addEventListener("mousedown", this.outsideClickHandler, true)
      }
    }, 0)
  }

  close(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener("mousedown", this.outsideClickHandler, true)
      this.outsideClickHandler = undefined
    }

    if (this.container?.parentElement) {
      this.container.parentElement.removeChild(this.container)
    }
    this.container = null

    if (this.onClose) {
      this.onClose()
    }
  }

  private render(): void {
    if (!this.container) return

    this.container.innerHTML = ""

    const header = this.container.createEl("div", {
      cls: "taskchute-move-calendar__header",
    })

    const prevBtn = header.createEl("button", {
      cls: "taskchute-move-calendar__nav taskchute-move-calendar__nav--prev",
      attr: {
        "aria-label": t(
          'taskChuteView.moveCalendar.prevMonth',
          'Previous month',
        ),
      },
    })
    prevBtn.textContent = "‹"
    prevBtn.addEventListener("click", () => {
      this.changeMonth(-1)
    })

    header.createEl("div", {
      cls: "taskchute-move-calendar__title",
      text: this.monthFormatter.format(this.currentMonth),
    })

    const nextBtn = header.createEl("button", {
      cls: "taskchute-move-calendar__nav taskchute-move-calendar__nav--next",
      attr: {
        "aria-label": t(
          'taskChuteView.moveCalendar.nextMonth',
          'Next month',
        ),
      },
    })
    nextBtn.textContent = "›"
    nextBtn.addEventListener("click", () => {
      this.changeMonth(1)
    })

    const weekdayRow = this.container.createEl("div", {
      cls: "taskchute-move-calendar__weekdays",
    })
    this.weekdayLabels.forEach((day, index) => {
      const cell = weekdayRow.createEl("div", {
        cls: "taskchute-move-calendar__weekday",
        text: day,
      })
      if (index === 0) cell.classList.add("is-sunday")
      if (index === 6) cell.classList.add("is-saturday")
    })

    const grid = this.container.createEl("div", {
      cls: "taskchute-move-calendar__grid",
    })

    const firstDay = new Date(
      this.currentMonth.getFullYear(),
      this.currentMonth.getMonth(),
      1,
    )
    const startDayIndex = firstDay.getDay()

    const daysInMonth = new Date(
      this.currentMonth.getFullYear(),
      this.currentMonth.getMonth() + 1,
      0,
    ).getDate()
    const daysInPrevMonth = new Date(
      this.currentMonth.getFullYear(),
      this.currentMonth.getMonth(),
      0,
    ).getDate()

    // Previous month trailing days
    for (let i = startDayIndex; i > 0; i -= 1) {
      const date = new Date(
        this.currentMonth.getFullYear(),
        this.currentMonth.getMonth() - 1,
        daysInPrevMonth - i + 1,
      )
      this.createDayButton(grid, date, false)
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(
        this.currentMonth.getFullYear(),
        this.currentMonth.getMonth(),
        day,
      )
      this.createDayButton(grid, date, true)
    }

    // Next month leading days to fill grid (6 rows * 7 columns = 42 cells)
    const totalCells = grid.childElementCount
    for (let i = totalCells; i < 42; i += 1) {
      const date = new Date(
        this.currentMonth.getFullYear(),
        this.currentMonth.getMonth() + 1,
        i - totalCells + 1,
      )
      this.createDayButton(grid, date, false)
    }

    const footer = this.container.createEl("div", {
      cls: "taskchute-move-calendar__footer",
    })

    const clearButton = footer.createEl("button", {
      cls: "taskchute-move-calendar__action taskchute-move-calendar__action--clear",
      text: t('taskChuteView.moveCalendar.clear', 'Clear'),
    })
    clearButton.addEventListener("click", async () => {
      if (this.onClear) {
        await this.onClear()
      }
      this.close()
    })

    const todayButton = footer.createEl("button", {
      cls: "taskchute-move-calendar__action taskchute-move-calendar__action--today",
      text: t('taskChuteView.moveCalendar.today', 'Today'),
    })
    todayButton.addEventListener("click", async () => {
      const todayIso = toISODate(this.today)
      await this.onSelect(todayIso)
      this.close()
    })
  }

  private createDayButton(
    container: HTMLElement,
    date: Date,
    inCurrentMonth: boolean,
  ): void {
    const isoDate = toISODate(date)
    const button = container.createEl("button", {
      cls: "taskchute-move-calendar__day",
      attr: { "data-date": isoDate },
      text: String(date.getDate()),
    }) as HTMLButtonElement

    if (!inCurrentMonth) {
      button.classList.add("is-outside")
    }

    const weekday = date.getDay()
    if (weekday === 0) button.classList.add("is-sunday")
    if (weekday === 6) button.classList.add("is-saturday")

    if (isSameDate(date, this.today)) {
      button.classList.add("is-today")
    }
    if (isSameDate(date, this.selectedDate)) {
      button.classList.add("is-selected")
    }

    button.addEventListener("click", async () => {
      this.selectedDate = cloneDate(date)
      await this.onSelect(isoDate)
      this.close()
    })
  }

  private changeMonth(offset: number): void {
    this.currentMonth = new Date(
      this.currentMonth.getFullYear(),
      this.currentMonth.getMonth() + offset,
      1,
    )
    this.render()
    this.position()
  }

  private position(): void {
    if (!this.container) return

    const rect = this.anchor.getBoundingClientRect()
    const calendarRect = this.container.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = rect.left
    let top = rect.bottom + 8

    if (left + calendarRect.width > viewportWidth - 16) {
      left = Math.max(16, viewportWidth - calendarRect.width - 16)
    }
    if (top + calendarRect.height > viewportHeight - 16) {
      top = rect.top - calendarRect.height - 8
      if (top < 16) {
        top = Math.max(16, viewportHeight - calendarRect.height - 16)
      }
    }

    this.container.style.left = `${left}px`
    this.container.style.top = `${top}px`
  }
}

export default TaskMoveCalendar
