import type { Page } from "@playwright/test"
import { TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-314: the AI pane gives the terminal room. By default it takes half of
// the view, with a slim header; full screen (⤢) is the whole view, the date
// row included; collapsing from full screen leaves the header bar and the
// task list, and opening again returns to full screen.
//
// The pane shows a real Codex run in the terminal (any agent would do; Codex
// shows no account details on screen). The checks measure the layout.

const TASK = "README を要約する"
const taskPath = `${TASK_FOLDER}/${TASK}.md`
const README = "---\ntitle: 引っ越しメモ\n---\n# 引っ越しメモ\n\n- 10月20日に引っ越す\n- 電気・ガス・水道の手続きを10月15日までに済ませる\n- 郵便の転送届を出す\n"

function localDateKey(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Heights of the parts that share the view, in CSS pixels. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const height = (selector: string) => {
      const el = document.querySelector(selector)
      if (!el || getComputedStyle(el).display === "none") return 0
      return Math.round(el.getBoundingClientRect().height)
    }
    return {
      dateRow: height(".top-bar-container"),
      main: height(".main-container"),
      pane: height(".ai-pane-container"),
      header: height(".ai-run-pane__header"),
      taskList: height(".task-list-container"),
    }
  })
}

/** The terminal's rows as drawn, without spacing. */
/**
 * Clicks one of the pane's buttons, then rests the pointer on the header's
 * title: the layout moves under the pointer, which would otherwise end up
 * over some other button and show its tooltip.
 */
async function press(page: Page, recorder: { click(target: ReturnType<Page["locator"]>): Promise<void>; hover(target: ReturnType<Page["locator"]>): Promise<void> }, selector: string) {
  await recorder.click(page.locator(selector))
  await recorder.hover(page.locator(".ai-run-pane__title"))
}

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".ai-run-pane .xterm-rows")
    return (rows[rows.length - 1]?.textContent ?? "").replace(/\s+/g, "")
  })
}

test("ai-pane-layout", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  await enableAiTasks(page, "claude", "terminal")
  await createNotes(page, {
    "README.md": README,
    [taskPath]: [
      "---",
      "tags:",
      "  - task",
      `target_date: "${localDateKey()}"`,
      "ai_task: true",
      "ai_task_host: codex",
      "---",
      "",
      "## Prompt",
      "",
      "README.md を読んで、引っ越しまでにやることを3行でまとめて",
      "",
    ].join("\n"),
  })
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await expect.poll(() => rowState(row)).toBe("idle")

  await recorder.start("AI 実行ペインで、ターミナルを広く見られるようにする", {
    sub: "本物の Codex を、ターミナルで動かします",
  })

  await recorder.chapter("① AI タスクを開始する", { sub: "AI 実行ペインが、ビューの半分の高さで開く。見出しの行は細い" })
  await recorder.click(row.locator(".play-stop-button"))
  await recorder.hover(page.locator(".taskchute-view-root .task-list-container"))
  await expect.poll(() => rowState(row)).toBe("running")
  await expect.poll(async () => (await layout(page)).pane, { timeout: 20_000 }).toBeGreaterThan(0)
  const normal = await layout(page)
  expect(normal.pane / normal.main).toBeGreaterThan(0.47)
  expect(normal.pane / normal.main).toBeLessThan(0.53)
  expect(normal.header).toBeLessThanOrEqual(25)
  // Codex asks once whether to trust a folder it has not been in.
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toMatch(/trust|信頼|README/i)
  if (/trust/i.test(await terminalText(page))) {
    await recorder.caption("① AI タスクを開始する", { sub: "初めてのフォルダなので、Codex が信頼するか聞く。Enter で進める" })
    await recorder.click(page.locator(".ai-run-pane .xterm").first())
    await page.keyboard.press("Enter")
  }
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toMatch(/10月|電気|転送/)
  await recorder.pause(2000)

  await recorder.chapter("② 全画面にする（⤢）", { sub: "日付の行も消えて、ビュー全体がペインになる" })
  await press(page, recorder, ".ai-run-pane__expand")
  await expect.poll(async () => (await layout(page)).dateRow).toBe(0)
  const full = await layout(page)
  expect(full.pane).toBe(full.main)
  await recorder.pause(2500)

  await recorder.chapter("③ 全画面のまま折りたたむ（⌄）", { sub: "日付の行とタスク一覧が戻り、下に AI 実行の帯が残る" })
  await press(page, recorder, ".ai-run-pane__collapse")
  await expect.poll(async () => (await layout(page)).dateRow).toBeGreaterThan(0)
  const collapsed = await layout(page)
  expect(collapsed.header).toBeGreaterThan(0)
  expect(collapsed.taskList).toBeGreaterThan(collapsed.pane)
  await recorder.pause(2000)

  await recorder.chapter("④ もう一度開く（⌄）", { sub: "全画面に戻る" })
  await press(page, recorder, ".ai-run-pane__collapse")
  await expect.poll(async () => (await layout(page)).dateRow).toBe(0)
  expect((await layout(page)).pane).toBe(full.main)
  await recorder.pause(2000)

  await recorder.chapter("⑤ 元の大きさに戻す（⤢）", { sub: "ビューの半分の高さに戻り、日付の行とタスク一覧が見える" })
  await press(page, recorder, ".ai-run-pane__expand")
  await expect.poll(async () => (await layout(page)).dateRow).toBeGreaterThan(0)
  const back = await layout(page)
  expect(back.pane / back.main).toBeGreaterThan(0.47)
  expect(back.pane / back.main).toBeLessThan(0.53)
  await recorder.pause(2500)
})
