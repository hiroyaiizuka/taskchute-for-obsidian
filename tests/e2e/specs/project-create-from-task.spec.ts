import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, taskRow, todayKey } from "../helpers/aiTask"

// LEV-319: a task's project is picked like Obsidian's quick switcher, and a
// name no project has is created and linked in the same step. One modal.

const PROJECTS = "Projects"

async function createNote(page: Page, file: string, lines: string[]): Promise<void> {
  await page.evaluate(
    async ([target, data]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      const folder = target.slice(0, target.lastIndexOf("/"))
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(target, data)
    },
    [file, lines.join("\n")] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as { metadataCache: { getCache(path: string): { frontmatter?: unknown } | null } }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, file)
}

async function setUp(page: Page, projects: string[]): Promise<string> {
  await page.evaluate(
    ([id, folder]) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
      plugin.settings.projectsFolder = folder
    },
    [PLUGIN_ID, PROJECTS] as const,
  )
  for (const name of projects) {
    await createNote(page, `${PROJECTS}/Project - ${name}.md`, ["---", "status: todo", "---", ""])
  }
  const taskPath = `${TASK_FOLDER}/記事を書く.md`
  await createNote(page, taskPath, ["---", "tags:", "  - task", `target_date: "${await todayKey(page)}"`, "---", ""])
  await openTaskChute(page)
  return taskPath
}

/** Opens the task's project picker from its settings menu (the way in on a phone too). */
async function openPicker(page: Page, taskPath: string) {
  await taskRow(page, taskPath).locator(".settings-task-button").click()
  await page.locator(".task-settings-tooltip .tooltip-item", { hasText: /プロジェクトを設定|Set project/ }).click()
  const picker = page.locator(".taskchute-project-picker")
  await expect(picker).toBeVisible()
  return {
    picker,
    input: picker.locator(".prompt-input"),
    rows: picker.locator(".suggestion-item"),
  }
}

const read = (vaultDir: string, file: string) => fs.readFileSync(path.join(vaultDir, file), "utf8")

async function expectOnBoardTodo(page: Page, title: string): Promise<void> {
  const view = page.locator(".taskchute-view-root")
  await view.locator(".drawer-toggle").click()
  await view.locator('.navigation-nav-item[data-section="projects"]').click()
  await expect(
    page.locator('.project-board-column[data-status="todo"] .project-board-card', { hasText: title }),
  ).toBeVisible()
}

test("typing a new name in a task's project picker creates the project and links it", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  const taskPath = await setUp(page, ["ブログ記事", "引っ越し"])

  const { picker, input, rows } = await openPicker(page, taskPath)
  await expect(rows).toHaveText(["ブログ記事", "引っ越し"])

  // A close match stays first, so Enter would pick it; creating comes right below.
  await input.fill("ブロ")
  await expect(rows).toHaveText(["ブログ記事", /「ブロ」を作成|Create "ブロ"/])

  await input.fill("ブログ連載")
  await expect(rows).toHaveText([/「ブログ連載」を作成|Create "ブログ連載"/])
  await input.press("Enter")
  await expect(picker).toHaveCount(0)

  await expect.poll(() => read(vaultDir, taskPath)).toContain("[[Project - ブログ連載]]")
  expect(read(vaultDir, `${PROJECTS}/Project - ブログ連載.md`)).toMatch(/status: todo/)
  await expect(taskRow(page, taskPath).locator(".taskchute-project-name")).toHaveText("ブログ連載")

  // Offered next time, marked as the task's own, and on the board's todo column.
  const again = await openPicker(page, taskPath)
  await expect(again.rows.filter({ hasText: "ブログ連載" })).toContainText("✓")
  await page.keyboard.press("Escape")
  await expectOnBoardTodo(page, "ブログ連載")
})

test("with no project yet, typing a name creates the first one; closing makes nothing", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  const taskPath = await setUp(page, [])

  const first = await openPicker(page, taskPath)
  await expect(first.picker).toContainText(/まだプロジェクトがありません|No projects yet/)
  await first.input.fill("取り消すもの")
  await page.keyboard.press("Escape")
  await expect(first.picker).toHaveCount(0)
  expect(fs.existsSync(path.join(vaultDir, PROJECTS, "Project - 取り消すもの.md"))).toBe(false)

  const second = await openPicker(page, taskPath)
  await second.input.fill("最初のプロジェクト")
  await second.rows.first().click()
  await expect.poll(() => read(vaultDir, taskPath)).toContain("[[Project - 最初のプロジェクト]]")
  await expectOnBoardTodo(page, "最初のプロジェクト")
})
