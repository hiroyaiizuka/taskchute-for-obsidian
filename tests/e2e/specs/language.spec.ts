import { expect, test } from "../fixtures"

const PLUGIN_ID = "taskchute-plus"

// Every surface below must follow Obsidian's language. Strings are the
// dictionary values, so a key that stops resolving shows the English fallback
// and fails the ja run.
const LANGUAGES = [
  {
    language: "en",
    settingsHeading: "TaskChute file paths",
    addTaskAria: "Add new task",
    navigation: ["Routine", "Review", "Log", "Projects", "Settings"],
    addTaskTitle: "Add new task",
    addTaskNameLabel: "Task name:",
    projectsTab: "Projects",
    projectFolderUnset: "Project folder not configured",
  },
  {
    language: "ja",
    settingsHeading: "タスクシュートのファイルパス",
    addTaskAria: "新しいタスクを追加",
    navigation: ["ルーチン", "レビュー", "ログ", "プロジェクト", "設定"],
    addTaskTitle: "新しいタスクを追加",
    addTaskNameLabel: "タスク名:",
    projectsTab: "プロジェクト",
    projectFolderUnset: "プロジェクトフォルダが設定されていません",
  },
] as const

for (const expected of LANGUAGES) {
  test.describe(`in ${expected.language}`, () => {
    test.use({ language: expected.language })

    test("localizes the settings tab", async ({ obsidian }) => {
      const { page } = obsidian
      await page.evaluate((id) => {
        window.app.setting.open()
        window.app.setting.openTabById(id)
      }, PLUGIN_ID)

      // Settings live in a popout window; read them through the settings object.
      await expect
        .poll(() => page.evaluate(() => window.app.setting.activeTab?.containerEl.textContent ?? ""))
        .toContain(expected.settingsHeading)
      await page.evaluate(() => window.app.setting.close())
    })

    test("localizes the view header and navigation", async ({ obsidian }) => {
      const { page } = obsidian
      await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-taskchute-view`)
      const view = page.locator(".taskchute-view-root")

      await expect(view.locator(".add-task-button")).toHaveAttribute("aria-label", expected.addTaskAria)
      const labels = view.locator(".navigation-nav-label")
      for (const label of expected.navigation) {
        await expect(labels.filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(1)
      }
    })

    test("localizes the add-task modal", async ({ obsidian }) => {
      const { page } = obsidian
      await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-taskchute-view`)
      await page.locator(".taskchute-view-root .add-task-button").click()

      const modal = page.locator(".modal-container").last()
      await expect(modal).toContainText(expected.addTaskTitle)
      await expect(modal).toContainText(expected.addTaskNameLabel)
      await page.keyboard.press("Escape")
    })

    test("localizes the project board", async ({ obsidian }) => {
      const { page } = obsidian
      await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-taskchute-view`)
      const view = page.locator(".taskchute-view-root")
      await view.locator(".drawer-toggle").click()
      await view.locator('.navigation-nav-item[data-section="projects"]').click()

      // The board's tab title and its "no project folder" state (the default).
      await expect
        .poll(() =>
          page.evaluate(() => {
            const leaf = window.app.workspace.getLeavesOfType("taskchute-project-board")[0] as
              | { view?: { getDisplayText?: () => string } }
              | undefined
            return leaf?.view?.getDisplayText?.() ?? null
          }),
        )
        .toBe(expected.projectsTab)
      await expect(page.getByText(expected.projectFolderUnset, { exact: true })).toBeVisible()
    })
  })
}
