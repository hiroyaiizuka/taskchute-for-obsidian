import TaskMoveCalendar from "../../src/ui/components/TaskMoveCalendar"

interface CreateElOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

type MockHTMLDivElement = Omit<HTMLDivElement, 'createEl'> & {
  createEl?: (tag: string, options?: CreateElOptions) => HTMLElement;
};

const setActiveDocument = (doc: Document): void => {
  ;(globalThis as typeof globalThis & { activeDocument: Document }).activeDocument = doc
}

// createElメソッドのモック
beforeAll(() => {
  // HTMLDivElementのプロトタイプにcreateElを追加
  const proto = HTMLDivElement.prototype as unknown as MockHTMLDivElement;
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
  const proto = HTMLDivElement.prototype as unknown as MockHTMLDivElement;
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

  it("removes outside click listener from the document that registered it", () => {
    const originalActiveDocument = activeDocument
    const sourceDoc = document.implementation.createHTMLDocument("source")
    const focusedDoc = document.implementation.createHTMLDocument("focused")
    const sourceAdd = jest.spyOn(sourceDoc, "addEventListener")
    const sourceRemove = jest.spyOn(sourceDoc, "removeEventListener")
    const focusedRemove = jest.spyOn(focusedDoc, "removeEventListener")
    const popoutAnchor = sourceDoc.createElement("button")
    sourceDoc.body.appendChild(popoutAnchor)
    const popoutCalendar = new TaskMoveCalendar({
      anchor: popoutAnchor,
      initialDate: new Date(2025, 8, 24),
      today: new Date(2025, 8, 24),
      onSelect: jest.fn(),
    })

    jest.useFakeTimers()

    try {
      setActiveDocument(sourceDoc)
      popoutCalendar.open()
      jest.runOnlyPendingTimers()

      expect(sourceAdd).toHaveBeenCalledWith("mousedown", expect.any(Function), true)

      setActiveDocument(focusedDoc)
      popoutCalendar.close()

      expect(sourceRemove).toHaveBeenCalledWith("mousedown", expect.any(Function), true)
      expect(focusedRemove).not.toHaveBeenCalledWith("mousedown", expect.any(Function), true)
    } finally {
      popoutCalendar.close()
      calendar.close()
      setActiveDocument(originalActiveDocument)
      jest.useRealTimers()
      sourceAdd.mockRestore()
      sourceRemove.mockRestore()
      focusedRemove.mockRestore()
    }
  })

  it("fills only the weeks the month touches", () => {
    // September 2025 starts on a Monday and ends on a Tuesday: five weeks, so
    // the fixed 42-cell grid used to hang a seventh row of next-month days off
    // the bottom.
    calendar.open()
    expect(document.querySelectorAll(".taskchute-move-calendar__day")).toHaveLength(35)
    calendar.close()

    // February 2026: starts Sunday, 28 days -- exactly four weeks, no padding
    // of any kind, and certainly not two spare rows of next-month days.
    const february = new TaskMoveCalendar({
      anchor,
      initialDate: new Date(2026, 1, 10),
      today: new Date(2026, 1, 10),
      onSelect: jest.fn(),
    })
    try {
      february.open()
      const days = document.querySelectorAll(".taskchute-move-calendar__day")
      expect(days).toHaveLength(28)
      expect(document.querySelectorAll(".taskchute-move-calendar__day.is-outside")).toHaveLength(0)
    } finally {
      february.close()
    }
  })

  it("centres the calendar on the mobile shell instead of hanging it off the anchor", () => {
    document.body.classList.add("is-mobile")
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 })
    const rectSpy = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const size = this.classList.contains("taskchute-move-calendar")
          ? { width: 358, height: 360 }
          : { width: 10, height: 10 }
        return {
          top: 0,
          right: size.width,
          bottom: size.height,
          left: 0,
          width: size.width,
          height: size.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }
      })

    try {
      calendar.open()

      const calendarEl = document.querySelector<HTMLElement>(".taskchute-move-calendar")
      expect(calendarEl?.style.left).toBe("16px")
      expect(calendarEl?.style.top).toBe("170px")
    } finally {
      rectSpy.mockRestore()
      document.body.classList.remove("is-mobile")
    }
  })

  it("clamps position using the anchor document window", () => {
    const iframe = document.createElement("iframe")
    document.body.appendChild(iframe)
    const popoutDocument = iframe.contentDocument
    const popoutWindow = iframe.contentWindow
    if (!popoutDocument || !popoutWindow) {
      throw new Error("iframe window unavailable")
    }
    Object.defineProperty(popoutWindow, "innerWidth", { configurable: true, value: 120 })
    Object.defineProperty(popoutWindow, "innerHeight", { configurable: true, value: 100 })
    const popoutAnchor = popoutDocument.createElement("button")
    popoutDocument.body.appendChild(popoutAnchor)
    Object.defineProperty(popoutAnchor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 80,
        right: 110,
        bottom: 90,
        left: 100,
        width: 10,
        height: 10,
        x: 100,
        y: 80,
        toJSON: () => ({}),
      } as DOMRect),
    })
    const rectSpy = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.classList.contains("taskchute-move-calendar")) {
        return {
          top: 0,
          right: 80,
          bottom: 50,
          left: 0,
          width: 80,
          height: 50,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }
      }
      return {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }
    })
    const popoutCalendar = new TaskMoveCalendar({
      anchor: popoutAnchor,
      initialDate: new Date(2025, 8, 24),
      today: new Date(2025, 8, 24),
      onSelect: jest.fn(),
    })

    try {
      popoutCalendar.open()

      const calendarEl = popoutDocument.querySelector<HTMLElement>(".taskchute-move-calendar")
      expect(calendarEl?.style.left).toBe("24px")
      expect(calendarEl?.style.top).toBe("22px")
    } finally {
      popoutCalendar.close()
      rectSpy.mockRestore()
      iframe.remove()
    }
  })
})
