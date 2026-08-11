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

  it("returns English strings for task view recipe actions", () => {
    setLocaleOverride("en")

    expect(t("taskChuteView.buttons.setRecipe", "fallback")).toBe("🍽 set recipe")
    expect(t("taskChuteView.buttons.changeRecipe", "fallback")).toBe("🍽 change recipe")
    expect(t("taskChuteView.forms.recipeDescription", "fallback")).toBe(
      "Assign a reusable recipe to this task",
    )
    expect(t("taskChuteView.navigation.recipes", "fallback")).toBe("Recipes")
  })

  it("returns localized strings for recipe settings", () => {
    setLocaleOverride("en")
    expect(t("settings.recipe.heading", "fallback")).toBe("Recipes")
    expect(t("settings.recipe.enable", "fallback")).toBe("Enable recipe feature")

    setLocaleOverride("ja")
    expect(t("settings.recipe.heading", "fallback")).toBe("レシピ")
    expect(t("settings.recipe.enable", "fallback")).toBe("レシピ機能を有効化")
  })
})
