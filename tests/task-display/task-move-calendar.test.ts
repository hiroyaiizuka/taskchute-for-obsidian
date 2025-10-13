import TaskMoveCalendar from "../../src/ui/components/TaskMoveCalendar"

interface CreateElOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

interface MockHTMLDivElement extends HTMLDivElement {
  createEl?: (tag: string, options?: CreateElOptions) => HTMLElement;
}

// createElメソッドのモック
beforeAll(() => {
  // HTMLDivElementのプロトタイプにcreateElを追加
  const proto = HTMLDivElement.prototype as MockHTMLDivElement;
  proto.createEl = function(tag: string, options?: CreateElOptions) {
    const el = document.createElement(tag)
    if (options?.cls) el.className = options.cls
    if (options?.text) el.textContent = options.text
    if (options?.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        el.setAttribute(key, value)
      })
    }
    this.appendChild(el)
    return el
  }
})

afterAll(() => {
  // クリーンアップ
  const proto = HTMLDivElement.prototype as MockHTMLDivElement;
  delete proto.createEl;
})

describe("TaskMoveCalendar", () => {
  let anchor: HTMLElement
  let calendar: TaskMoveCalendar

  beforeEach(() => {
    document.body.innerHTML = ""
    anchor = document.createElement("button")
    anchor.textContent = "anchor"
    document.body.appendChild(anchor)

    calendar = new TaskMoveCalendar({
      anchor,
      initialDate: new Date(2025, 8, 24),
      today: new Date(2025, 8, 24),
      onSelect: jest.fn(),
    })
  })

  afterEach(() => {
    calendar.close()
  })

  it("renders current month and highlights selected date", () => {
    calendar.open()
    const rendered = document.querySelector(".taskchute-move-calendar")
    expect(rendered).not.toBeNull()

    const selected = rendered?.querySelector(
      ".taskchute-move-calendar__day.is-selected",
    )
    expect(selected?.getAttribute("data-date")).toBe("2025-09-24")

    const clearButton = rendered?.querySelector(
      ".taskchute-move-calendar__action--clear",
    )
    expect(clearButton).toBeNull()
  })

  it("invokes onSelect for today button", () => {
    const onSelect = jest.fn()
    calendar.close()
    calendar = new TaskMoveCalendar({
      anchor,
      initialDate: new Date(2025, 8, 1),
      today: new Date(2025, 8, 24),
      onSelect,
    })

    calendar.open()

    const todayButton = document.querySelector(
      ".taskchute-move-calendar__action--today",
    )
    ;(todayButton as HTMLButtonElement).click()

    expect(onSelect).toHaveBeenCalledWith("2025-09-24")
  })
})
