import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, aiRuns, enableAiTasks, openTaskChute, rowState, taskRow, todayKey } from "../../helpers/aiTask"
import { realClaudePath, runIdOf, waitForClaude } from "../aiTerminal"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-405: "Restart AI terminals" ends the running terminals and replaces the
// broker they run in, so the next terminal starts on a new one. The AI tasks
// running in them stop as with their stop button, which the dialog says.
// Follows the issue's "done when": with a terminal running, the command
// rebuilds it.
//
// The automatic retry and the notice's button need a broker that refuses to
// start a terminal; the integration tests cover those, this video does not.
// Recorded with the real Claude Code CLI of whoever records.

const TASK = "議事録をまとめる"
const taskPath = `${TASK_FOLDER}/${TASK}.md`
const SECOND = "メールを下書きする"
const secondPath = `${TASK_FOLDER}/${SECOND}.md`

function note(today: string, prompt: string): string {
  return ["---", "tags:", "  - task", `target_date: "${today}"`, "ai_task: true", "ai_task_host: claude", "---", "", "## Prompt", "", prompt, ""].join("\n")
}

/** The pid of the broker this vault's terminals run in, or null when none runs. */
async function brokerPid(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const req = (window as unknown as { require: (name: string) => unknown }).require
    const crypto = req("crypto") as typeof import("crypto")
    const fs = req("fs") as typeof import("fs")
    const os = req("os") as typeof import("os")
    const path = req("path") as typeof import("path")
    const basePath = (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath()
    const hash = crypto.createHash("sha256").update(`taskchute-plus:${basePath}`).digest("hex").slice(0, 24)
    try {
      const file = path.join(os.tmpdir(), `taskchute-plus-ai-broker-${hash}.json`)
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number }).pid
    } catch {
      return null
    }
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("ai-restart-terminals", async ({ obsidian, recorder }) => {
  test.setTimeout(300_000)
  const { page } = obsidian
  await enableAiTasks(page, await realClaudePath(), "terminal")
  const today = await todayKey(page)
  await createNotes(page, {
    [taskPath]: note(today, "会議の議事録の見出しの例を 3 つ、箇条書きで挙げてください。"),
    [secondPath]: note(today, "取引先へのお礼のメールの件名を 1 つ考えてください。"),
  })
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  const second = taskRow(page, secondPath)
  await expect.poll(() => rowState(row)).toBe("idle")

  try {
    await recorder.start("AI のターミナルを、コマンドで再起動する", {
      sub: "ターミナルを動かす仕組み（ブローカー）ごと作り直す。Claude Code は本物です",
    })

    await recorder.chapter("① AI タスクを開始する", { sub: "ターミナルで AI が動く" })
    await recorder.click(row.locator(".play-stop-button"))
    await expect.poll(() => rowState(row)).toBe("running")
    await expect.poll(() => runIdOf(page, taskPath), { timeout: 30_000 }).not.toBeNull()
    await waitForClaude(page, (await runIdOf(page, taskPath))!, () =>
      recorder.caption("① AI タスクを開始する", { sub: "初めてのフォルダなので、信頼するか聞かれる。Enter で進める" }),
    )
    const oldBroker = await brokerPid(page)
    expect(oldBroker).not.toBeNull()
    await recorder.caption("① AI タスクを開始する", {
      sub: `ターミナルは、ブローカー（プロセス番号 ${oldBroker}）の中で動いている`,
      say: "ターミナルは、ブローカーの中で動いています。",
    })

    await recorder.chapter("② コマンド「AI のターミナルを再起動」を選ぶ", {
      sub: "動いているターミナルと、止まる AI タスクの数が、先に確認に出る",
    })
    await page.keyboard.press("ControlOrMeta+p")
    const palette = page.locator(".prompt-input")
    await palette.waitFor()
    await page.keyboard.insertText("AI のターミナルを再起動")
    const item = page.locator(".suggestion-item", { hasText: "AI のターミナルを再起動" }).first()
    await recorder.click(item)
    const dialog = page.locator(".modal").filter({ hasText: "動いているターミナル 1 個が終わります" })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("実行中の AI タスク 1 個は、停止ボタンを押したときと同じように止まり、完了になります")
    await recorder.pause(1_500)

    await recorder.chapter("③ 「再起動」を押す", { sub: "ターミナルが終わり、AI タスクも止まって完了になる。古いブローカーも終わる" })
    await recorder.click(dialog.getByRole("button", { name: "再起動" }))
    const runStatus = async () => (await aiRuns(page)).find((run) => run.taskPath === taskPath)?.status ?? "gone"
    await expect.poll(runStatus, { timeout: 30_000 }).not.toBe("running")
    await expect.poll(() => rowState(row), { timeout: 30_000 }).toBe("done")
    await expect.poll(() => processAlive(oldBroker!), { timeout: 30_000 }).toBe(false)
    await expect(page.locator(".notice", { hasText: "ターミナルを再起動しました" })).toBeVisible()
    await recorder.caption("③ 「再起動」を押す", {
      sub: `「${TASK}」は完了。ブローカー（${oldBroker}）は終わった`,
      say: "タスクは完了になり、古いブローカーは終わりました。",
    })

    await recorder.chapter("④ 別の AI タスクを開始する", { sub: "新しいブローカーで動く" })
    await recorder.click(second.locator(".play-stop-button"))
    await expect.poll(() => rowState(second)).toBe("running")
    await expect.poll(() => runIdOf(page, secondPath), { timeout: 30_000 }).not.toBeNull()
    await waitForClaude(page, (await runIdOf(page, secondPath))!)
    const newBroker = await brokerPid(page)
    expect(newBroker).not.toBeNull()
    expect(newBroker).not.toBe(oldBroker)
    expect(processAlive(newBroker!)).toBe(true)
    await recorder.caption("④ 別の AI タスクを開始する", {
      sub: `新しいブローカー（プロセス番号 ${newBroker}）で動いている`,
      say: "新しいブローカーで動いています。",
    })
    await recorder.pause(1_500)
  } finally {
    // The broker outlives Obsidian's process group; stop it here.
    await page
      .evaluate(async (id) => {
        const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: { disposeAndWait(): Promise<void> } })
          .aiTaskManager
        await manager?.disposeAndWait()
      }, PLUGIN_ID)
      .catch(() => undefined)
  }
})
