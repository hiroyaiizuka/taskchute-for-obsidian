import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-367: the day's comments window no longer shows "Enter to add · Shift+Enter
// for a new line · Esc to close" under its input every time. The keys work as
// before. Record it twice with the same script: once on the build before the
// change (TASKCHUTE_RECORD_BUILD=before, which expects the line), once after.

const BEFORE = process.env.TASKCHUTE_RECORD_BUILD === "before"

const dayButton = (page: Page) => page.locator(".taskchute-day-comments-button")
const dayWindow = (page: Page) => page.locator(".taskchute-day-comments-window")
const dayInput = (page: Page) => dayWindow(page).locator(".taskchute-day-comments-window__input textarea")
const hint = (page: Page) => dayWindow(page).locator(".taskchute-day-comments-window__input .taskchute-comment-hint")

test("day-comments-hint", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.dayCommentsEnabled = true
    await plugin.saveSettings()
  }, PLUGIN_ID)
  const today = await todayKey(page)
  const frontmatter = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  await createNotes(page, {
    [`${TASK_FOLDER}/企画書を書く.md`]: frontmatter,
    [`${TASK_FOLDER}/メール処理.md`]: frontmatter,
    [`${TASK_FOLDER}/週次の振り返り.md`]: frontmatter,
  })
  await openTaskChute(page)

  await recorder.start(BEFORE ? "変更前：今日のコメントの入力欄の下に、説明文が毎回出る" : "変更後：今日のコメントの入力欄の下の説明文をなくした", {
    sub: `LEV-367 · ${BEFORE ? "main e888263" : "このブランチ"} · Mac 版（デスクトップ）`,
  })

  await recorder.chapter("① 右下のボタンで開く", {
    sub: BEFORE ? "入力欄の下に「Enter で追加・Shift+Enter で改行・Esc で閉じる」" : "入力欄の下に説明文は出ない",
  })
  await recorder.click(dayButton(page))
  await expect(dayInput(page)).toBeFocused()
  if (BEFORE) await expect(hint(page)).toHaveText("Enter で追加・Shift+Enter で改行・Esc で閉じる")
  else await expect(hint(page)).toHaveCount(0)

  await recorder.chapter("② Enter で追加する", { sub: "これまでどおり追加される" })
  await dayInput(page).pressSequentially("判断軸(ADR)の形成に役立てる", { delay: 40 })
  await dayInput(page).press("Enter")
  await expect(dayWindow(page).locator(".taskchute-comment-text")).toHaveText(["判断軸(ADR)の形成に役立てる"])

  await recorder.chapter("③ Shift+Enter で改行して追加する", { sub: "改行もこれまでどおり" })
  await dayInput(page).pressSequentially("1 行目", { delay: 40 })
  await dayInput(page).press("Shift+Enter")
  await dayInput(page).pressSequentially("2 行目", { delay: 40 })
  await dayInput(page).press("Enter")
  await expect(dayWindow(page).locator(".taskchute-comment-text")).toHaveText(["判断軸(ADR)の形成に役立てる", "1 行目\n2 行目"])

  await recorder.chapter("④ Esc で閉じる", { sub: "ウィンドウが閉じる" })
  await page.keyboard.press("Escape")
  await expect(dayWindow(page)).toHaveCount(0)
  await recorder.pause(1200)
})
