import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, rowState, taskRow, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-346: the day's comments behind a button at the bottom right of the task
// list (a drawer on a phone): written only for today, deleted but not
// rewritten, and the window stays open while tasks are started and stopped.
// LEV-347: a running task's comments are deleted but not rewritten either, and
// the completion modal lists them under the ratings.
// Nothing is faked; the comments in the opening state are written through the
// plugin before the recording starts.

const TASKS = ["企画書を書く", "メール処理", "Linear のロードマップ見直し", "週次の振り返り"]

const dayButton = (page: Page) => page.locator(".taskchute-day-comments-button")
const dayBadge = (page: Page) => dayButton(page).locator(".taskchute-day-comments-button__count")
const dayWindow = (page: Page) => page.locator(".taskchute-day-comments-window")
const dayInput = (page: Page) => dayWindow(page).locator(".taskchute-day-comments-window__input textarea")
const dayTexts = (page: Page) => dayWindow(page).locator(".taskchute-comment-text")

async function setUp(page: Page): Promise<string> {
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.dayCommentsEnabled = true
    await plugin.saveSettings()
  }, PLUGIN_ID)
  const today = await todayKey(page)
  const frontmatter = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  await createNotes(page, Object.fromEntries(TASKS.map((title) => [`${TASK_FOLDER}/${title}.md`, frontmatter])))
  await openTaskChute(page)
  await expect(page.locator(".taskchute-view-root .task-item")).toHaveCount(TASKS.length)
  return today
}

/** A comment written on another day, through the view's own store. */
async function addCommentOn(page: Page, dateKey: string, text: string): Promise<void> {
  await page.evaluate(
    async ([key, body]) => {
      const leaves: unknown[] = window.app.workspace.getLeavesOfType("taskchute-view")
      const { view } = leaves[0] as {
        view: { dayStateManager: { addCommentTo(dateKey: string, input: { text: string }): Promise<unknown> } }
      }
      await view.dayStateManager.addCommentTo(key, { text: body })
    },
    [dateKey, text] as const,
  )
}

function previousDay(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  const date = new Date(y, m - 1, d - 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

test("day-comments", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  const today = await setUp(page)
  await addCommentOn(page, previousDay(today), "集中できた日。朝のルーチンを短くしてもいいかも")
  const report = `${TASK_FOLDER}/企画書を書く.md`
  const roadmap = `${TASK_FOLDER}/Linear のロードマップ見直し.md`

  await recorder.start("今日のコメントは、タスク一覧の右下のボタンから開く", {
    sub: "LEV-346 / LEV-347 · Mac 版（デスクトップ）",
  })

  await recorder.chapter("① 右下のボタンを押す", { sub: "ウィンドウが開き、すぐに書ける" })
  await recorder.click(dayButton(page))
  await expect(dayWindow(page)).toBeVisible()
  await expect(dayInput(page)).toBeFocused()

  await recorder.chapter("② Enter で追加する", { sub: "一覧の一番下に出て、件数が増える" })
  await dayInput(page).pressSequentially("判断軸(ADR)の形成に役立てる", { delay: 40 })
  await dayInput(page).press("Enter")
  await dayInput(page).pressSequentially("タスクが圧迫されないのがいい", { delay: 40 })
  await dayInput(page).press("Enter")
  await expect(dayTexts(page)).toHaveText(["判断軸(ADR)の形成に役立てる", "タスクが圧迫されないのがいい"])
  await expect(dayWindow(page).locator(".taskchute-day-comments-window__count")).toHaveText("2 件")

  await recorder.chapter("③ 開いたまま、タスクを再生する", { sub: "ウィンドウは閉じずに残る" })
  await recorder.click(taskRow(page, roadmap).locator(".play-stop-button"))
  await expect.poll(() => rowState(taskRow(page, roadmap))).toBe("running")
  await expect(dayWindow(page)).toBeVisible()

  await recorder.chapter("④ コメントは書き換えられない", { sub: "押しても編集欄は開かない（タイポもそのまま残す）" })
  await recorder.click(dayTexts(page).first())
  await expect(dayWindow(page).locator(".taskchute-comment-editor")).toHaveCount(0)

  await recorder.chapter("⑤ × で削除する", { sub: "通知の「元に戻す」で戻せる" })
  const second = dayWindow(page).locator(".taskchute-comment-list > li").nth(1)
  await recorder.hover(second)
  await recorder.click(second.locator(".taskchute-comment-delete"))
  await expect(dayTexts(page)).toHaveText(["判断軸(ADR)の形成に役立てる"])
  await recorder.click(page.locator(".taskchute-undo-notice__button"))
  await expect(dayTexts(page)).toHaveText(["判断軸(ADR)の形成に役立てる", "タスクが圧迫されないのがいい"])

  await recorder.chapter("⑥ Esc で閉じる", { sub: "ボタンに件数のバッジが出る" })
  await dayInput(page).focus()
  await page.keyboard.press("Escape")
  await expect(dayWindow(page)).toHaveCount(0)
  await expect(dayBadge(page)).toHaveText("2")

  await recorder.chapter("⑦ 前の日に移ってから開く", { sub: "過去の日は読むだけ。追加できるのは今日だけ" })
  await recorder.click(page.locator(".top-bar-container .date-nav-arrow").first())
  await expect(dayBadge(page)).toHaveText("1")
  await recorder.click(dayButton(page))
  await expect(dayTexts(page)).toHaveText(["集中できた日。朝のルーチンを短くしてもいいかも"])
  await expect(dayInput(page)).toHaveCount(0)
  await expect(dayWindow(page).locator(".taskchute-day-comments-window__only-today")).toBeVisible()
  await recorder.click(dayWindow(page).locator(".taskchute-day-comments-window__close"))
  await recorder.click(page.locator(".top-bar-container .date-nav-arrow").last())
  await expect(dayBadge(page)).toHaveText("2")

  await recorder.chapter("⑧ 実行中タスクの 💬 にもコメントする", { sub: "こちらも書き換えはできず、削除だけ" })
  await recorder.click(taskRow(page, report).locator(".play-stop-button"))
  await expect.poll(() => rowState(taskRow(page, report))).toBe("running")
  await recorder.click(taskRow(page, report).locator(".comment-button"))
  const panelInput = page.locator(".taskchute-task-comments textarea")
  await expect(panelInput).toBeFocused()
  await panelInput.pressSequentially("構成は 3 章で決まり", { delay: 40 })
  await panelInput.press("Enter")
  await expect(taskRow(page, report).locator(".comment-button__count")).toHaveText("1")
  const panelText = page.locator(".taskchute-task-comments .taskchute-comment-text")
  await recorder.click(panelText)
  await expect(page.locator(".taskchute-task-comments .taskchute-comment-editor")).toHaveCount(0)
  await expect(page.locator(".taskchute-task-comments .taskchute-comment-delete")).toHaveCount(1)

  await recorder.chapter("⑨ 停止して、完了のコメントを開く", { sub: "実行中のコメントは、元気度の下に出る" })
  await recorder.click(taskRow(page, report).locator(".play-stop-button"))
  await expect.poll(() => rowState(taskRow(page, report))).toBe("done")
  await recorder.click(taskRow(page, report).locator(".comment-button"))
  const recap = page.locator(".taskchute-comment-modal .taskchute-comment-recap")
  await expect(recap.locator(".taskchute-comment-text")).toHaveText(["構成は 3 章で決まり"])
  const order = await page.evaluate(() => {
    const recapEl = document.querySelector(".taskchute-comment-modal .taskchute-comment-recap")!
    return {
      afterEnergy: recapEl.previousElementSibling?.textContent?.includes("元気度") ?? false,
      beforeNotes: !!recapEl.nextElementSibling?.querySelector("textarea"),
    }
  })
  expect(order).toEqual({ afterEnergy: true, beforeNotes: true })
  await expect(recap.locator(".taskchute-comment-delete")).toHaveCount(1)
  await recorder.pause(1500)
})

test("day-comments-phone", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  await page.evaluate(() => (window.app as unknown as { emulateMobile(on: boolean): void }).emulateMobile(true))
  await page.waitForTimeout(1500)
  await setUp(page)

  await recorder.start("スマホでは、右下のボタンから", { sub: "全画面のドロワーで開く（モバイル表示）", size: { width: 390, height: 844 } })
  await expect(page.locator("body.is-phone")).toHaveCount(1)
  await openTaskChute(page)

  await recorder.chapter("① ボタンを押す", { sub: "画面全体を覆うドロワー" })
  await recorder.click(dayButton(page))
  await expect(dayWindow(page)).toHaveClass(/is-drawer/)

  await recorder.chapter("② 書いて「追加」", { sub: "Enter は改行" })
  await recorder.click(dayInput(page))
  await dayInput(page).pressSequentially("移動中に思いついたこと", { delay: 40 })
  await recorder.click(dayWindow(page).locator(".taskchute-comment-composer__add"))
  await expect(dayTexts(page)).toHaveText(["移動中に思いついたこと"])

  await recorder.chapter("③ × で削除できる", { sub: "通知から元に戻せる" })
  await recorder.click(dayWindow(page).locator(".taskchute-comment-delete"))
  await expect(dayTexts(page)).toHaveCount(0)
  await recorder.click(page.locator(".taskchute-undo-notice__button"))
  await expect(dayTexts(page)).toHaveText(["移動中に思いついたこと"])

  await recorder.chapter("④ 上のバーを下へ引いて閉じる", { sub: "ボタンに件数が出る" })
  const handle = dayWindow(page).locator(".taskchute-day-comments-window__handle")
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 320, { steps: 20 })
  await page.mouse.up()
  await expect(dayWindow(page)).toHaveCount(0)
  await expect(dayBadge(page)).toHaveText("1")
  await recorder.pause(1200)
})
