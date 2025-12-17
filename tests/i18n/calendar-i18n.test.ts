import {
  initializeLocaleManager,
  setLocaleOverride,
  t,
} from "../../src/i18n"

describe("calendar export i18n", () => {
  beforeAll(() => {
    initializeLocaleManager("en")
  })

  afterEach(() => {
    setLocaleOverride("en")
  })

  it("returns English strings for calendar export", () => {
    setLocaleOverride("en")
    expect(t("taskChuteView.calendar.export.title")).toBe(
      "Register to google calendar",
    )
    expect(t("taskChuteView.calendar.export.toGoogle")).toContain(
      "register calender",
    )
  })

  it("returns Japanese strings for calendar export", () => {
    setLocaleOverride("ja")
    expect(t("taskChuteView.calendar.export.title")).toBe(
      "Googleカレンダーに登録",
    )
    expect(t("taskChuteView.calendar.export.toGoogle")).toContain(
      "Googleカレンダー",
    )
  })
})
