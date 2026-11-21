import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, taskRow, todayKey } from "../helpers/aiTask"

// LEV-345: "Change or remove recipe" in a task's ⚙ menu opens the same edit
// dialog as the recipe popover's ✏, with the recipe's contents, plus "Remove
// recipe" at the bottom. "Set recipe" on a task without one is unchanged.

const RECIPE_PATH = "TaskChute/Recipes/Weekly review.md"
const WITH_RECIPE = `${TASK_FOLDER}/Weekly retro.md`
const WITHOUT_RECIPE = `${TASK_FOLDER}/Email.md`

function recipeDocument(): string {
  return [
    "---",
    "taskchute_recipe: true",
    "taskchute_recipe_version: 2",
    'title: "Weekly review"',
    "---",
    "",
    "<!-- taskchute-recipe:goal:start -->",
    "## 完了基準",
    "",
    "Next week's top three are on the calendar",
    "<!-- taskchute-recipe:goal:end -->",
    "",
    "<!-- taskchute-recipe:checklist:start -->",
    "## 手順チェックリスト",
    "",
    "- [ ] Look back at this week <!-- taskchute-step-id: step-1 -->",
    "- [ ] Pick next week's top three <!-- taskchute-step-id: step-2 -->",
    "<!-- taskchute-recipe:checklist:end -->",
    "",
    "<!-- taskchute-recipe:quality-checklist:start -->",
    "## 品質基準チェックリスト",
    "",
    "<!-- taskchute-recipe:quality-checklist:end -->",
    "",
    "<!-- taskchute-recipe:constraints:start -->",
    "## 制約・ルール",
    "",
    "<!-- taskchute-recipe:constraints:end -->",
    "",
  ].join("\n")
}

async function setUp(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.recipeFeatureEnabled = true
    await plugin.saveSettings()
  }, PLUGIN_ID)
  const today = await todayKey(page)
  const task = (recipe?: string) =>
    ["---", "tags:", "  - task", `target_date: "${today}"`, ...(recipe ? [`recipe: "[[${recipe}]]"`] : []), "---", ""].join("\n")
  const notes: Array<[string, string]> = [
    [RECIPE_PATH, recipeDocument()],
    [WITH_RECIPE, task(RECIPE_PATH)],
    [WITHOUT_RECIPE, task()],
  ]
  await page.evaluate(async (entries) => {
    const vault = window.app.vault as unknown as {
      getAbstractFileByPath(path: string): unknown
      createFolder(path: string): Promise<unknown>
      create(path: string, data: string): Promise<unknown>
    }
    for (const [file, content] of entries) {
      const folder = file.slice(0, file.lastIndexOf("/"))
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(file, content)
    }
  }, notes)
  await page.waitForFunction(
    (paths) =>
      paths.every((p) => {
        const app = window.app as unknown as { metadataCache: { getCache(path: string): { frontmatter?: unknown } | null } }
        return !!app.metadataCache.getCache(p)?.frontmatter
      }),
    notes.map(([p]) => p),
  )
  await openTaskChute(page)
  await expect(taskRow(page, WITH_RECIPE).locator(".recipe-task-badge")).toBeVisible()
}

async function openMenuItem(page: Page, taskPath: string, label: string): Promise<void> {
  await taskRow(page, taskPath).locator(".settings-task-button").click()
  await page.locator(".task-settings-tooltip .tooltip-item", { hasText: label }).click()
}

const dialog = (page: Page) => page.locator(".modal.recipe-modal-content")

test("Change or remove recipe opens the popover's edit dialog with the recipe's contents, and saving rewrites the recipe", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await setUp(page)

  await openMenuItem(page, WITH_RECIPE, "Change or remove recipe")
  await expect(dialog(page).locator(".modal-title")).toHaveText("Edit recipe")
  await expect(dialog(page).locator(".recipe-title-input")).toHaveValue("Weekly review")
  await expect(dialog(page).locator(".recipe-goal-input")).toHaveValue("Next week's top three are on the calendar")
  await expect(dialog(page).locator(".recipe-step-input")).toHaveCount(2)
  await expect(dialog(page).locator(".modal-button-container button")).toHaveText(["Remove recipe", "Cancel", "Save"])

  await dialog(page).locator(".recipe-add-step-button").first().click()
  await dialog(page).locator(".recipe-step-input").nth(2).fill("Block time on the calendar")
  await dialog(page).getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => fs.readFileSync(path.join(vaultDir, RECIPE_PATH), "utf8"))
    .toContain("Block time on the calendar")
})

test("Remove recipe at the bottom of that dialog takes the recipe off the task and keeps the recipe", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await setUp(page)

  await openMenuItem(page, WITH_RECIPE, "Change or remove recipe")
  await dialog(page).locator(".recipe-unassign-button").click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(taskRow(page, WITH_RECIPE).locator(".recipe-task-badge")).toHaveCount(0)
  await expect.poll(() => fs.readFileSync(path.join(vaultDir, WITH_RECIPE), "utf8")).not.toContain("recipe:")
  expect(fs.existsSync(path.join(vaultDir, RECIPE_PATH))).toBe(true)
})

test("the popover's ✏ opens the same dialog without Remove recipe", async ({ obsidian }) => {
  const { page } = obsidian
  await setUp(page)

  await taskRow(page, WITH_RECIPE).locator(".recipe-task-badge").click()
  await page.locator(".recipe-run-edit-button").click()
  await expect(dialog(page).locator(".modal-title")).toHaveText("Edit recipe")
  await expect(dialog(page).locator(".modal-button-container button")).toHaveText(["Cancel", "Save"])
})

test("Set recipe on a task without one still opens the picker", async ({ obsidian }) => {
  const { page } = obsidian
  await setUp(page)

  await openMenuItem(page, WITHOUT_RECIPE, "Set recipe")
  await expect(dialog(page).locator(".modal-title")).toHaveText("Set recipe")
  await expect(dialog(page).locator(".recipe-search-input")).toBeVisible()
  await expect(dialog(page).locator(".recipe-unassign-button")).toHaveCount(0)
})
