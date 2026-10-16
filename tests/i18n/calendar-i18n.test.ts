import { t } from "@/i18n"
import { setObsidianLanguage } from "@tests/utils/locale"

describe("calendar export i18n", () => {
  beforeAll(() => {
    setObsidianLanguage("en")
  })

  afterEach(() => {
    setObsidianLanguage("en")
  })

  it("returns English strings for calendar export", () => {
    setObsidianLanguage("en")
    expect(t("taskChuteView.calendar.export.title")).toBe(
      "Register to Google Calendar",
    )
    expect(t("taskChuteView.calendar.export.toGoogle")).toContain(
      "Register calendar",
    )
  })

  it("returns Japanese strings for calendar export", () => {
    setObsidianLanguage("ja")
    expect(t("taskChuteView.calendar.export.title")).toBe(
      "Googleカレンダーに登録",
    )
    expect(t("taskChuteView.calendar.export.toGoogle")).toContain(
      "Googleカレンダー",
    )
  })

  it("returns English strings for task view recipe actions", () => {
    setObsidianLanguage("en")

    expect(t("taskChuteView.buttons.setRecipe", "fallback")).toBe("🍽 Set recipe")
    expect(t("taskChuteView.forms.recipeDescription", "fallback")).toBe(
      "Assign a reusable recipe to this task",
    )
    expect(t("taskChuteView.navigation.recipes", "fallback")).toBe("Recipes")
  })

  it("returns localized strings for recipe settings", () => {
    setObsidianLanguage("en")
    expect(t("settings.recipe.heading", "fallback")).toBe("Recipes")
    expect(t("settings.recipe.enable", "fallback")).toBe("Enable recipe feature")

    setObsidianLanguage("ja")
    expect(t("settings.recipe.heading", "fallback")).toBe("レシピ")
    expect(t("settings.recipe.enable", "fallback")).toBe("レシピ機能を有効化")
  })
})
