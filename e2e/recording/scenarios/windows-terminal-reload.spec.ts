import { PLUGIN_ID, TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow, todayKey } from "../../helpers/aiTask"
import { disposeAiRuns, printed, realClaudePath, runIdOf, runStatusOf, tabOf, terminalOf } from "../aiTerminal"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-404: on Windows a terminal outlives a reload of the Obsidian window, as
// on macOS: its process runs in the broker, and after the reload the pane
// joins the same terminal again. Recorded with the real Claude Code CLI.
//
// The AI task feature needs a licence; the recording stubs it in memory, so
// it is stubbed again after the reload. An Obsidian restart (quit and start
// within 60 s) is not in this video.

const TASK = "首都を調べる"
const taskPath = `${TASK_FOLDER}/${TASK}.md`
const PROMPT = "日本の首都を一言で答えてください。"
const FOLLOW_UP = "その都市の人口はおよそ何人？一言で"
const COUNT = '1..600 | % { "カウント $_"; Start-Sleep 1 }'

/** The highest "カウント N" the + terminal has printed so far. */
async function lastCount(page: Parameters<typeof printed>[0], runId: string): Promise<number> {
  const counts = [...(await printed(page, runId)).matchAll(/カウント(\d+)/g)].map((match) => Number(match[1]))
  return counts.length ? Math.max(...counts) : 0
}

test("windows-terminal-reload", async ({ obsidian, recorder }) => {
  test.skip(process.platform !== "win32", "LEV-404 is about Windows")
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
    await recorder.start("Windows でも、ウィンドウを再読み込みしてもターミナルが残る", {
      sub: "Claude Code は本物です。ライセンスは試験用に差し替えています",
    })

    await recorder.chapter("① AI タスクを開始する", { sub: "Claude Code が答える" })
    await recorder.click(row.locator(".play-stop-button"))
    await expect.poll(() => runIdOf(page, taskPath), { timeout: 30_000 }).not.toBeNull()
    const task = (await runIdOf(page, taskPath))!
    await expect.poll(() => printed(page, task), { timeout: 60_000 }).toMatch(/trustthisfolder|ClaudeCodev\d/)
    if ((await printed(page, task)).includes("trustthisfolder")) {
      await recorder.caption("① AI タスクを開始する", { sub: "初めてのフォルダなので、信頼するか聞かれる。Enter で進める" })
      await recorder.click(terminalOf(page, task))
      await page.keyboard.press("Enter")
    }
    await expect
      .poll(async () => (await printed(page, task)).split(PROMPT).pop() ?? "", { timeout: 120_000 })
      .toContain("東京")

    await recorder.chapter("② 「+」のターミナルで、1 秒ごとに数を数える", { sub: "PowerShell が数え続ける" })
    await recorder.click(page.locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__add").first())
    await expect.poll(() => runIdOf(page, null), { timeout: 30_000 }).not.toBeNull()
    const shell = (await runIdOf(page, null))!
    await expect.poll(() => printed(page, shell), { timeout: 30_000 }).toContain("PS")
    await recorder.click(terminalOf(page, shell))
    await page.keyboard.type(COUNT, { delay: 30 })
    await page.keyboard.press("Enter")
    await expect.poll(() => lastCount(page, shell), { timeout: 30_000 }).toBeGreaterThanOrEqual(5)
    const beforeReload = await lastCount(page, shell)

    await recorder.chapter("③ ウィンドウを再読み込みする", {
      sub: "コマンド「保存せずにアプリを再読み込み」と同じ操作",
      say: "ウィンドウを再読み込みします。",
    })
    await recorder.settle()
    // Wait for the new document: the old one still answers until it unloads.
    const reloaded = page.waitForEvent("load")
    await page.evaluate(() => window.app.commands.executeCommandById("app:reload")).catch(() => undefined)
    await reloaded
    await page.waitForFunction(() => window.app?.workspace?.layoutReady === true, undefined, { timeout: 60_000 })
    await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, { timeout: 60_000 })
    await enableAiTasks(page, claudePath, "terminal")
    await recorder.reattach()
    await openTaskChute(page)

    await recorder.chapter("④ 同じターミナルに戻る", {
      sub: "数は止まらずに進んでいる。Claude Code の画面もそのまま",
    })
    await expect.poll(() => runStatusOf(page, shell), { timeout: 30_000 }).toBe("running")
    await expect.poll(() => runStatusOf(page, task), { timeout: 30_000 }).toBe("running")
    await expect(tabOf(page, shell)).toBeVisible({ timeout: 30_000 })
    await recorder.click(tabOf(page, shell))
    await expect.poll(() => lastCount(page, shell), { timeout: 30_000 }).toBeGreaterThan(beforeReload + 3)
    await recorder.caption("④ 同じターミナルに戻る", {
      sub: `再読み込みの前は ${beforeReload}。数は止まらずに進んでいる`,
      say: "数は止まらずに進んでいます。",
    })

    await recorder.chapter("⑤ AI に続けて聞く", { sub: "前の話の続きとして答える。同じ Claude Code が動き続けている" })
    await recorder.click(tabOf(page, task))
    await recorder.click(terminalOf(page, task))
    await page.keyboard.type(FOLLOW_UP, { delay: 60 })
    await page.keyboard.press("Enter")
    // An answer after the whole question that gives a number of people
    // ("約1,400万人" or "約14,000,000人"). The question names no city;
    // answering it needs the first answer.
    await expect
      .poll(
        async () => {
          const shown = await printed(page, task)
          return shown.includes(FOLLOW_UP) ? (shown.split(FOLLOW_UP).pop() ?? "") : ""
        },
        { timeout: 120_000 },
      )
      .toMatch(/\d[\d,]*万人|\d{1,3}(?:,\d{3}){2,}人|\d{7,}人/)
    await recorder.pause(3_000)
  } finally {
    await disposeAiRuns(page)
  }
})
