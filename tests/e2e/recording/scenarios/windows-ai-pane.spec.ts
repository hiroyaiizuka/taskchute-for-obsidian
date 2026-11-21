import { TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow, todayKey } from "../../helpers/aiTask"
import { disposeAiRuns, printed, realClaudePath, runIdOf, runStatusOf, tabOf, terminalOf } from "../aiTerminal"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-402: on Windows the AI run pane and its terminals act as on macOS.
// Follows the issue's table: ① + opens a terminal, ② the terminal splits,
// ③ the AI CLI ending returns to the shell and keeps the tab, ④ a + tab is
// named after the program running in it. Recorded on Windows with the real
// Claude Code CLI of whoever records (the fake CLI is a POSIX script).

const TASK = "首都を調べる"
const taskPath = `${TASK_FOLDER}/${TASK}.md`
const PROMPT = "日本の首都を一言で答えてください。"

test("windows-ai-pane", async ({ obsidian, recorder }) => {
  test.skip(process.platform !== "win32", "LEV-402 is about Windows")
  test.setTimeout(300_000)
  const { page } = obsidian

  const claudePath = await realClaudePath()
  await enableAiTasks(page, claudePath, "terminal")
  await createNotes(page, {
    [taskPath]: ["---", "tags:", "  - task", `target_date: "${await todayKey(page)}"`, "ai_task: true", "ai_task_host: claude", "---", "", "## Prompt", "", PROMPT, ""].join("\n"),
  })
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await expect.poll(() => rowState(row)).toBe("idle")

  try {
    await recorder.start("Windows でも、AI ペインとターミナルが macOS と同じに動く", {
      sub: "Claude Code は本物です",
    })

    await recorder.chapter("準備：AI タスクを開始する", { sub: "AI のタブが開き、Claude Code が答える" })
    await recorder.click(row.locator(".play-stop-button"))
    await expect.poll(() => runIdOf(page, taskPath), { timeout: 30_000 }).not.toBeNull()
    const task = (await runIdOf(page, taskPath))!
    await expect(tabOf(page, task).locator(".ai-run-pane__tab-label")).toHaveText(TASK)
    await expect.poll(() => printed(page, task), { timeout: 60_000 }).toMatch(/trustthisfolder|ClaudeCodev\d/)
    if ((await printed(page, task)).includes("trustthisfolder")) {
      await recorder.caption("準備：AI タスクを開始する", { sub: "初めてのフォルダなので、信頼するか聞かれる。Enter で進める" })
      await recorder.click(terminalOf(page, task))
      await page.keyboard.press("Enter")
    }
    await expect
      .poll(async () => (await printed(page, task)).split(PROMPT).pop() ?? "", { timeout: 120_000 })
      .toContain("東京")

    await recorder.chapter("① 「+」を押す", { sub: "PowerShell のターミナルが開き、タブの名前は「ターミナル」" })
    await recorder.click(page.locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__add").first())
    await expect.poll(() => runIdOf(page, null), { timeout: 30_000 }).not.toBeNull()
    const shell = (await runIdOf(page, null))!
    const shellLabel = tabOf(page, shell).locator(".ai-run-pane__tab-label")
    await expect.poll(() => printed(page, shell), { timeout: 30_000 }).toContain("PS")
    await expect(shellLabel).toHaveText("ターミナル")

    await recorder.chapter("② 「+」のタブでプログラムを動かす", {
      sub: "タブの名前が、動いているプログラムの名前に変わる。終わると「ターミナル」に戻る",
    })
    await recorder.click(terminalOf(page, shell))
    await page.keyboard.type("ping -n 10 127.0.0.1", { delay: 50 })
    await page.keyboard.press("Enter")
    await expect(shellLabel).not.toHaveText("ターミナル", { timeout: 15_000 })
    await recorder.pause(2_000)
    await expect(shellLabel).toHaveText("ターミナル", { timeout: 30_000 })

    await recorder.chapter("③ AI の CLI を終える", { sub: "同じタブで PowerShell に戻り、タブは残る" })
    await recorder.click(tabOf(page, task))
    await recorder.click(terminalOf(page, task))
    const beforeExit = (await printed(page, task)).length
    await page.keyboard.type("/exit", { delay: 80 })
    await page.keyboard.press("Enter")
    await expect
      .poll(async () => (await printed(page, task)).slice(beforeExit), { timeout: 30_000 })
      .toContain("PS")
    expect(await runStatusOf(page, task)).toBe("running")
    await expect(tabOf(page, task)).toBeVisible()
    await recorder.pause(2_000)

    await recorder.chapter("④ ターミナルを分割する", { sub: "ペインが左右に分かれる" })
    await recorder.click(page.locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__split").first())
    await expect(page.locator(".ai-run-pane__panel")).toHaveCount(2)
    await recorder.pause(2_500)
  } finally {
    await disposeAiRuns(page)
  }
})
