import type { Locator, Page } from "@playwright/test"
import { TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { FAKE_CLAUDE_BANNER, createNotes, waitForTerminalOutput, writeSwitchableFakeClaude } from "../helpers"

// LEV-290 / #183: a human task and the AI routine linked to it through
// `obsidian_sync` end up in the same state whichever one is operated.
// Follows the "after the fix" tables of the issue, top to bottom.

const HUMAN = "レポートを書く"
const AI = "AI レビュー"
const humanPath = `${TASK_FOLDER}/${HUMAN}.md`
const aiPath = `${TASK_FOLDER}/${AI}.md`

function localDateKey(offsetDays: number): string {
  const now = new Date()
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

function linkedPair(today: string): Record<string, string> {
  // Both are daily routines: the issue links routines only.
  const routine = [
    "isRoutine: true",
    "routine_type: daily",
    "routine_interval: 1",
    "routine_enabled: true",
    `routine_start: "${today}"`,
  ]
  return {
    [humanPath]: ["---", "tags:", "  - task", ...routine, "---", ""].join("\n"),
    [aiPath]: [
      "---",
      "tags:",
      "  - task",
      ...routine,
      "ai_task: true",
      "ai_task_host: claude",
      "obsidian_sync:",
      "  enabled: true",
      `  taskTitle: "${HUMAN}"`,
      "  matchType: exact",
      "---",
      "",
      "## Prompt",
      "",
      "レポートをレビューしてください。",
      "",
    ].join("\n"),
  }
}

test("ai-link-sync", async ({ obsidian, recorder }, testInfo) => {
  const { page } = obsidian
  const today = localDateKey(0)
  const tomorrow = localDateKey(1)

  const fake = writeSwitchableFakeClaude(testInfo.outputPath("bin"))
  await enableAiTasks(page, fake.file, "terminal")
  await createNotes(page, linkedPair(today))
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)

  const human = taskRow(page, humanPath)
  const ai = taskRow(page, aiPath)
  // Every scene ends on a check: a recording must not show a state the app
  // did not reach.
  const expectBoth = async (state: "idle" | "running" | "done" | "missing", timeout?: number) => {
    await expect.poll(() => rowState(human), { timeout }).toBe(state)
    await expect.poll(() => rowState(ai), { timeout }).toBe(state)
  }
  const menu = async (row: Locator, label: string) => {
    await recorder.click(row.locator(".settings-task-button"))
    const item = menuItem(page, label)
    await item.waitFor()
    await recorder.pause(500)
    await recorder.click(item)
  }
  await expectBoth("idle")

  await recorder.start("人間タスク「レポートを書く」と、紐づけた AI ルーチン「AI レビュー」", {
    sub: "どちらも未実行。AI は偽の CLI を、ターミナルで動かしています",
    say: "人間タスク「レポートを書く」と、それに紐づけた AI ルーチン「AI レビュー」があります。どちらも未実行です。",
  })

  await recorder.chapter("① 人間タスクを開始する", { sub: "AI ルーチンも実行中になる" })
  await recorder.click(human.locator(".play-stop-button"))
  await expectBoth("running")
  await waitForTerminalOutput(page, aiPath, FAKE_CLAUDE_BANNER)

  await recorder.chapter("② 人間タスクを停止する", { sub: "両方とも完了になる" })
  await recorder.click(human.locator(".play-stop-button"))
  await expectBoth("done")

  await recorder.chapter("③ 人間タスクを未実行に戻す", { sub: "AI ルーチンも未実行に戻る" })
  await menu(human, "未実行に戻す")
  await expectBoth("idle")

  await recorder.chapter("④ AI ルーチンを開始する", { sub: "人間タスクも実行中になる" })
  await recorder.click(ai.locator(".play-stop-button"))
  await expectBoth("running")
  await waitForTerminalOutput(page, aiPath, FAKE_CLAUDE_BANNER)

  await recorder.chapter("⑤ AI 実行ペインの × で止める", {
    sub: "両方とも完了になる（この課題の元のバグ）",
    say: "AI 実行ペインのバツで止めます。両方とも完了になります。以前は、人間タスクだけが実行中のまま残っていました。",
  })
  const runRow = page.locator(".ai-run-pane__run").filter({ hasText: AI })
  await runRow.waitFor()
  // The × takes pointer events only while its row is hovered.
  await recorder.hover(runRow)
  await recorder.click(runRow.locator(".ai-run-pane__run-close"))
  await expectBoth("done")

  // Not recorded: "the AI process finishes on its own". In the terminal a CLI
  // that exits hands the session back to the login shell, so the run does not
  // end by itself; that row of the issue's table holds for conversation mode
  // only (covered by e2e/specs/ai-link.spec.ts).

  await recorder.chapter("⑥ 片方を別の日付へ移動する", {
    sub: "まず未実行に戻してから、人間タスクを明日へ移す",
    say: "次は、日付の移動です。未実行に戻してから、人間タスクを明日へ移します。",
  })
  await menu(human, "未実行に戻す")
  await expectBoth("idle")
  await menu(human, "タスクを移動")
  const day = page.locator(`.taskchute-move-calendar__day[data-date="${tomorrow}"]`)
  // Tomorrow is in the next month on the last day of this one.
  if ((await day.count()) === 0) await recorder.click(page.locator(".taskchute-move-calendar__nav--next"))
  await day.waitFor()
  await recorder.click(day)
  await expectBoth("missing")
  await recorder.caption("⑥ 片方を別の日付へ移動する", {
    sub: "今日の一覧から 2 つとも消えた。明日を開く",
    say: "今日の一覧から、2 つとも消えました。明日を開きます。",
  })
  await recorder.click(page.locator(".taskchute-view-root .date-nav-arrow").last())
  await expectBoth("idle")
  await recorder.caption("⑥ 片方を別の日付へ移動する", {
    sub: "AI ルーチンも、同じ日付（明日）へ移っている",
    say: "AI ルーチンも、同じ日付へ移っています。",
  })

  await recorder.chapter("⑦ 片方を削除する", {
    sub: "AI ルーチンを削除すると、人間タスクのその日の分も消える",
  })
  await menu(ai, "タスクを削除")
  const confirm = page.locator(".modal-container .mod-warning")
  await confirm.waitFor()
  await recorder.pause(700)
  await recorder.click(confirm)
  await expectBoth("missing")
})

function menuItem(page: Page, label: string): Locator {
  return page.locator(".task-settings-tooltip .tooltip-item", { hasText: label })
}
