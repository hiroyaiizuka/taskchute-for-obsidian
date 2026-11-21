import type { Locator, Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, rowState, taskRow, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-366: on a computer with a mouse, the 💬 of a done task with no comment
// shows only while the pointer is on its row, the way a not-started task's
// controls do. Three rows: done with a comment, done without one, not started.
// The same script records the build before the fix and after it;
// TASKCHUTE_RECORD_PHASE=before expects the old, always-shown icon.
// Nothing is faked; the tasks are run and the comment is written through the
// plugin before the recording starts. Touch devices are not covered: their 💬
// stays as it is, and a desktop window cannot turn `(hover: none)` on.

const BEFORE = process.env.TASKCHUTE_RECORD_PHASE === "before"
const WITH_COMMENT = "企画書を書く"
const WITHOUT_COMMENT = "メール処理"
const NOT_STARTED = "週次の振り返り"
const TASKS = [WITH_COMMENT, WITHOUT_COMMENT, NOT_STARTED]
const path = (title: string) => `${TASK_FOLDER}/${title}.md`
const commentButton = (page: Page, title: string) => taskRow(page, path(title)).locator(".comment-button")
const SETUP = { timeout: 10_000 }

/** Whether the eye gets a 💬 at all. */
async function shown(button: Locator): Promise<boolean> {
  return button.evaluate((el) => {
    const style = getComputedStyle(el)
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
  })
}

async function runAndStop(page: Page, title: string): Promise<void> {
  const button = taskRow(page, path(title)).locator(".play-stop-button")
  await button.click(SETUP)
  await expect.poll(() => rowState(taskRow(page, path(title))), SETUP).toBe("running")
  await taskRow(page, path(title)).locator(".play-stop-button").click(SETUP)
  await expect.poll(() => rowState(taskRow(page, path(title))), SETUP).toBe("done")
}

test("comment-icon-done", async ({ obsidian, recorder }) => {
  test.setTimeout(180_000)
  const { page } = obsidian
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.dayCommentsEnabled = true
    await plugin.saveSettings()
  }, PLUGIN_ID)
  const today = await todayKey(page)
  const frontmatter = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  await createNotes(page, Object.fromEntries(TASKS.map((title) => [path(title), frontmatter])))
  await openTaskChute(page)
  await expect(page.locator(".taskchute-view-root .task-item")).toHaveCount(TASKS.length)

  await runAndStop(page, WITH_COMMENT)
  await commentButton(page, WITH_COMMENT).click(SETUP)
  const modal = page.locator(".taskchute-comment-modal")
  await modal.locator("textarea").fill("構成は 3 章で決まり", SETUP)
  await modal.locator(".modal-button-container button.create").click(SETUP)
  await expect(modal).toHaveCount(0, SETUP)
  await expect(commentButton(page, WITH_COMMENT)).toHaveClass(/active/, SETUP)
  await runAndStop(page, WITHOUT_COMMENT)
  await expect(commentButton(page, WITHOUT_COMMENT)).toHaveClass(/no-comment/, SETUP)

  const away = page.locator(".top-bar-container")
  await recorder.start(
    BEFORE ? "修正前: 完了タスクの 💬 は、コメントがなくても出ている" : "修正後: コメントのない 💬 は、ホバーしたときだけ出る",
    { sub: `LEV-366 · ${BEFORE ? "修正前" : "修正後"} · デスクトップ（マウスあり）` },
  )

  await recorder.chapter("① マウスを一覧から外す", {
    sub: BEFORE
      ? `「${WITH_COMMENT}」（コメントあり）も「${WITHOUT_COMMENT}」（なし）も 💬 が出ている`
      : `💬 が出るのは「${WITH_COMMENT}」（コメントあり）だけ`,
  })
  await recorder.hover(away)
  await expect.poll(() => shown(commentButton(page, WITH_COMMENT))).toBe(true)
  await expect.poll(() => shown(commentButton(page, WITHOUT_COMMENT))).toBe(BEFORE)
  await recorder.pause(1500)

  await recorder.chapter(`② 「${WITHOUT_COMMENT}」の行にマウスを乗せる`, { sub: "💬 が出る" })
  await recorder.hover(taskRow(page, path(WITHOUT_COMMENT)).locator(".task-name"))
  await expect.poll(() => shown(commentButton(page, WITHOUT_COMMENT))).toBe(true)

  await recorder.chapter("③ 💬 を押す", { sub: "コメントの入力が開く" })
  await recorder.click(commentButton(page, WITHOUT_COMMENT))
  await expect(modal).toBeVisible()
  await expect(modal.locator("textarea")).toHaveValue("")
  await recorder.click(modal.locator(".modal-button-container button.cancel"))
  await expect(modal).toHaveCount(0)

  await recorder.chapter("④ 未実施のタスクは、これまでどおり", { sub: `「${NOT_STARTED}」の行に乗せても 💬 は出ない` })
  await recorder.hover(taskRow(page, path(NOT_STARTED)).locator(".task-name"))
  await expect.poll(() => shown(commentButton(page, NOT_STARTED))).toBe(false)
  await recorder.hover(away)
  await expect.poll(() => shown(commentButton(page, WITHOUT_COMMENT))).toBe(BEFORE)
  await recorder.pause(1200)
})

// The same, on a phone: Obsidian's phone layout, with touch emulation so that
// `(hover: none)` holds the way it does on a real phone. Taps are mouse clicks.
test("comment-icon-done-phone", async ({ obsidian, recorder }) => {
  test.setTimeout(180_000)
  const { page } = obsidian
  await page.evaluate(() => {
    const host = window as unknown as {
      electron?: { remote?: { getCurrentWindow?: () => { setContentSize?: (w: number, h: number) => void } } }
    }
    host.electron?.remote?.getCurrentWindow?.()?.setContentSize?.(390, 844)
  })
  await page.evaluate(() => (window.app as unknown as { emulateMobile(on: boolean): void }).emulateMobile(true))
  await page.waitForFunction(() => document.body.classList.contains("is-phone"), undefined, SETUP)
  await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, SETUP)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  expect(await page.evaluate(() => window.matchMedia("(hover: none)").matches)).toBe(true)

  const today = await todayKey(page)
  const frontmatter = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  await createNotes(page, Object.fromEntries([WITH_COMMENT, WITHOUT_COMMENT].map((title) => [path(title), frontmatter])))
  await openTaskChute(page)
  await runAndStop(page, WITH_COMMENT)
  await commentButton(page, WITH_COMMENT).click(SETUP)
  const modal = page.locator(".taskchute-comment-modal")
  await modal.locator("textarea").fill("構成は 3 章で決まり", SETUP)
  await modal.locator(".modal-button-container button.create").click(SETUP)
  await expect(modal).toHaveCount(0, SETUP)
  await expect(commentButton(page, WITH_COMMENT)).toHaveClass(/active/, SETUP)
  await runAndStop(page, WITHOUT_COMMENT)
  await expect(commentButton(page, WITHOUT_COMMENT)).toHaveClass(/no-comment/, SETUP)

  await recorder.start(BEFORE ? "修正前: スマホでも、コメントのない 💬 が出ている" : "修正後: スマホでも、コメントのない 💬 は出さない", {
    sub: `LEV-366 · ${BEFORE ? "修正前" : "修正後"} · スマホ表示`,
    size: { width: 390, height: 844 },
  })
  await expect(page.locator("body.is-phone")).toHaveCount(1)

  await recorder.chapter("① 完了タスクを見る", {
    sub: BEFORE ? "コメントあり・なしの両方に 💬" : `💬 は「${WITH_COMMENT}」（コメントあり）だけ`,
  })
  await expect.poll(() => shown(commentButton(page, WITH_COMMENT))).toBe(true)
  await expect.poll(() => shown(commentButton(page, WITHOUT_COMMENT))).toBe(BEFORE)
  await recorder.pause(1500)

  await recorder.chapter(`② 「${WITHOUT_COMMENT}」の 💬 の場所をタップ`, { sub: "コメントの入力が開く" })
  await recorder.click(commentButton(page, WITHOUT_COMMENT))
  await expect(modal).toBeVisible()
  await expect(modal.locator("textarea")).toHaveValue("")
  await recorder.pause(1200)
})
