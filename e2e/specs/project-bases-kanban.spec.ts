import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, openTaskChute } from "../helpers/aiTask"
import { createNotes } from "../recording/helpers"

// LEV-317: "Projects" can open as an Obsidian Bases kanban (1.14+) instead of
// TaskChute's own board. The suite runs on 1.13.7 by default; run it with
// TASKCHUTE_E2E_OBSIDIAN_VERSION=1.14.4 for the kanban itself.

const PROJECTS = "Projects"
const BASE = `${PROJECTS}/TaskChute Projects.base`

// The running app's version. The user agent names the installer's, which on
// macOS and Windows is older than the app the suite puts in front of it.
async function obsidianVersion(page: Page): Promise<[number, number]> {
  const raw = await page.evaluate(() => {
    const electron = (window as unknown as {
      require(id: "electron"): { ipcRenderer: { sendSync(channel: "version"): string } }
    }).require("electron")
    return electron.ipcRenderer.sendSync("version").match(/^(\d+)\.(\d+)/)?.slice(1) ?? ["0", "0"]
  })
  return [Number(raw[0]), Number(raw[1])]
}

const hasKanban = ([major, minor]: [number, number]) => major > 1 || (major === 1 && minor >= 14)

async function setUp(page: Page, view: "board" | "bases"): Promise<void> {
  await page.evaluate(
    ([id, folder, mode]) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
      plugin.settings.projectsFolder = folder
      plugin.settings.projectBoardView = mode
    },
    [PLUGIN_ID, PROJECTS, view] as const,
  )
  const note = (status: string) => ["---", `status: ${status}`, "---", ""].join("\n")
  await createNotes(page, {
    [`${PROJECTS}/Project - 引っ越し.md`]: note("todo"),
    [`${PROJECTS}/Project - ブログ.md`]: note("in-progress"),
    [`${PROJECTS}/Project - 写真集.md`]: note("in_progress"),
  })
  await openTaskChute(page)
}

async function openProjects(page: Page): Promise<void> {
  // Only the TaskChute view on screen: an earlier one can sit in a background tab.
  const view = page.locator(".taskchute-view-root:visible")
  const item = view.locator('.navigation-nav-item[data-section="projects"]')
  if (!(await item.isVisible())) await view.locator(".drawer-toggle").click()
  await item.click()
}

const read = (vaultDir: string, file: string) => fs.readFileSync(path.join(vaultDir, file), "utf8")

test("before Obsidian 1.14 the Bases kanban cannot be chosen, and a saved choice opens the TaskChute board", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  test.skip(hasKanban(await obsidianVersion(page)), "Obsidian 1.14+ has the kanban")
  await setUp(page, "bases")

  await openProjects(page)
  await expect(page.locator(".project-board-view__header")).toBeVisible()
  expect(fs.existsSync(path.join(vaultDir, BASE))).toBe(false)

  await page.evaluate((id) => {
    const setting = (window.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting
    setting.open()
    setting.openTabById(id)
  }, PLUGIN_ID)
  // Settings live in a popout window; read them through the settings object.
  const row = () =>
    page.evaluate(() => {
      const root = (window.app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl
      const item = Array.from(root?.querySelectorAll<HTMLElement>(".setting-item") ?? []).find((el) => el.textContent?.includes("Project view"))
      return item ? { text: item.textContent ?? "", disabled: item.querySelector("select")?.disabled ?? null } : null
    })
  await expect.poll(row).toMatchObject({ disabled: true })
  expect((await row())?.text).toContain("needs Obsidian 1.14")
})

test("on Obsidian 1.14 \"Projects\" opens a Bases kanban that moves projects between statuses", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  test.skip(!hasKanban(await obsidianVersion(page)), "needs Obsidian 1.14+ (TASKCHUTE_E2E_OBSIDIAN_VERSION=1.14.4)")
  await setUp(page, "bases")

  await openProjects(page)
  const column = (name: string) =>
    page.locator(".bases-kanban-column", { has: page.locator(".bases-group-value", { hasText: new RegExp(`^${name}$`) }) })
  await expect(column("todo")).toContainText("Project - 引っ越し")
  // A status spelled another way gets a column of its own instead of vanishing.
  await expect(column("in_progress")).toContainText("Project - 写真集")
  expect(read(vaultDir, BASE)).toContain("type: kanban")

  await page.locator(".bases-kanban-card", { hasText: "Project - 引っ越し" }).dragTo(column("in-progress").locator(".bases-kanban-column-content"))
  await expect.poll(() => read(vaultDir, `${PROJECTS}/Project - 引っ越し.md`)).toContain("status: in-progress")

  // The file is the user's once it exists: opening again does not rewrite it.
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("bases"))
  await page.waitForTimeout(500)
  const edited = read(vaultDir, BASE).replace(/name: .*/, "name: 自分で付けた名前")
  fs.writeFileSync(path.join(vaultDir, BASE), edited)
  // Let Obsidian notice the change before the base is opened again.
  await page.waitForTimeout(1000)
  await openTaskChute(page)
  await openProjects(page)
  await expect(page.locator(".bases-toolbar-views-menu")).toContainText("自分で付けた名前")
  expect(read(vaultDir, BASE)).toContain("自分で付けた名前")

  // Back to the TaskChute board.
  await page.evaluate((id) => {
    ;(window.app.plugins.plugins[id] as { settings: Record<string, unknown> }).settings.projectBoardView = "board"
  }, PLUGIN_ID)
  await openTaskChute(page)
  await openProjects(page)
  await expect(page.locator(".project-board-view__header")).toBeVisible()
})
