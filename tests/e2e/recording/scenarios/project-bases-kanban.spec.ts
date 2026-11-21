import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import type { Recorder } from "../recorder"
import { PLUGIN_ID, openTaskChute } from "../../helpers/aiTask"
import { hasBasesKanban, obsidianAppVersion } from "../../obsidian/version"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-317: "Projects" opens as an Obsidian Bases kanban when chosen.
// Record with TASKCHUTE_E2E_OBSIDIAN_VERSION=1.14.4 (Bases has the kanban
// from 1.14). Obsidian opens its settings in a window of their own; the
// recording follows it there and back.

const PROJECTS = "Projects"
const BASE = `${PROJECTS}/TaskChute Projects.base`

/**
 * Opens TaskChute's settings from its menu (a window of its own), picks the
 * project view there, and closes it, with the recording following along.
 */
async function chooseViewInSettings(page: Page, recorder: Recorder, label: string): Promise<void> {
  const view = page.locator(".taskchute-view-root:visible")
  const item = view.locator('.navigation-nav-item[data-section="settings"]')
  if (!(await item.isVisible())) await recorder.click(view.locator(".drawer-toggle"))
  const opened = page.context().waitForEvent("page")
  await recorder.click(item)
  const settings = await opened
  await settings.waitForLoadState()
  await recorder.follow(settings)
  const row = settings.locator(".setting-item", { hasText: "プロジェクトの表示" })
  await row.scrollIntoViewIfNeeded()
  // Obsidian draws a second, hidden select to size the dropdown; the first is the real one.
  const select = row.locator("select").first()
  await recorder.hover(select)
  await select.selectOption({ label })
  await expect(select.locator("option:checked")).toHaveText(label)
  await recorder.pause(1800)
  await recorder.follow(page)
  await settings.close()
}

const read = (vaultDir: string, file: string) => fs.readFileSync(path.join(vaultDir, file), "utf8")

async function setView(page: Page, view: "board" | "bases"): Promise<void> {
  await page.evaluate(
    ([id, mode]) => {
      ;(window.app.plugins.plugins[id] as { settings: Record<string, unknown> }).settings.projectBoardView = mode
    },
    [PLUGIN_ID, view] as const,
  )
}

test("project-bases-kanban", async ({ obsidian, recorder }) => {
  const { page, vaultDir } = obsidian
  test.skip(!hasBasesKanban(await obsidianAppVersion(page)), "needs Obsidian 1.14+ (TASKCHUTE_E2E_OBSIDIAN_VERSION=1.14.4)")

  await page.evaluate(
    ([id, folder]) => {
      ;(window.app.plugins.plugins[id] as { settings: Record<string, unknown> }).settings.projectsFolder = folder
    },
    [PLUGIN_ID, PROJECTS] as const,
  )
  await setView(page, "board")
  const note = (status: string) => ["---", `status: ${status}`, "---", ""].join("\n")
  await createNotes(page, {
    [`${PROJECTS}/Project - 引っ越し.md`]: note("todo"),
    [`${PROJECTS}/Project - 確定申告.md`]: note("todo"),
    [`${PROJECTS}/Project - ブログ.md`]: note("in-progress"),
    [`${PROJECTS}/Project - 写真集.md`]: note("in_progress"),
    [`${PROJECTS}/Project - 旅行.md`]: note("done"),
  })
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)

  const view = page.locator(".taskchute-view-root:visible")
  const openProjects = async () => {
    const item = view.locator('.navigation-nav-item[data-section="projects"]')
    if (!(await item.isVisible())) await recorder.click(view.locator(".drawer-toggle"))
    await recorder.click(item)
  }
  const column = (name: string) =>
    page.locator(".bases-kanban-column", { has: page.locator(".bases-group-value", { hasText: new RegExp(`^${name}$`) }) })
  const card = (name: string) => page.locator(".bases-kanban-card", { hasText: name })

  await recorder.start("プロジェクトを、Obsidian Bases のカンバンで開く", {
    sub: "Obsidian 1.14.4 で操作します",
  })

  await recorder.chapter("① 設定で「プロジェクトの表示」を「Bases カンバン」にする", {
    sub: "メニューの「設定」から。設定は別のウィンドウで開く",
  })
  await chooseViewInSettings(page, recorder, "Bases カンバン")
  await expect.poll(() => page.evaluate((id) => (window.app.plugins.plugins[id] as { settings: Record<string, unknown> }).settings.projectBoardView, PLUGIN_ID)).toBe("bases")

  await recorder.chapter("② メニューの「プロジェクト」を開く", {
    sub: "プロジェクトのフォルダに .base ファイルができ、status ごとの列のカンバンで開く",
  })
  await openProjects()
  await expect(column("todo")).toContainText("Project - 引っ越し")
  expect(read(vaultDir, BASE)).toContain("type: kanban")
  await recorder.pause(2500)

  await recorder.chapter("③ 書き方の違う status も列になる", {
    sub: "「in_progress」と書かれたプロジェクトは、消えずに自分の列に出る",
  })
  await expect(column("in_progress")).toContainText("Project - 写真集")
  await recorder.hover(card("Project - 写真集"))
  await recorder.pause(2000)

  await recorder.chapter("④ カードを別の列へドラッグする", {
    sub: "「引っ越し」を todo から in-progress へ。ノートの status が書き換わる",
  })
  await recorder.hover(card("Project - 引っ越し"))
  await page.mouse.down()
  const target = await column("in-progress").locator(".bases-kanban-column-content").boundingBox()
  if (!target) throw new Error("the in-progress column is not on screen")
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 3, { steps: 30 })
  await page.mouse.up()
  await expect.poll(() => read(vaultDir, `${PROJECTS}/Project - 引っ越し.md`)).toContain("status: in-progress")
  await expect(column("in-progress")).toContainText("Project - 引っ越し")
  await recorder.pause(1500)

  await recorder.chapter("⑤ カードを開いて確かめる", {
    sub: "ノートのプロパティが「status: in-progress」になっている",
  })
  await recorder.click(card("Project - 引っ越し"))
  await expect(page.locator(".workspace-leaf.mod-active .metadata-container")).toContainText("in-progress")
  await recorder.pause(2500)

  await recorder.chapter("⑥ 設定を「TaskChute のボード」に戻して、もう一度開く", {
    sub: "これまでどおり TaskChute のボードが開く",
  })
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("bases"))
  await openTaskChute(page)
  await chooseViewInSettings(page, recorder, "TaskChute のボード")
  await openProjects()
  await expect(page.locator(".project-board-view__header")).toBeVisible()
  await recorder.pause(2500)
})
