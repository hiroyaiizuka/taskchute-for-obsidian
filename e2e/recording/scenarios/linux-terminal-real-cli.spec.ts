import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-339: on Linux the terminal of a real AI CLI stayed empty. An AI task is
// run in the terminal with the real Claude Code CLI of whoever records.
//
// One script, recorded on each build and platform that is to be compared:
//   TASKCHUTE_RECORD_BUILD=before  the caption says "修正前"; on Linux the
//                                  script checks for the bug (the terminal
//                                  stays empty until a key is pressed)
//                                  and fails on a build that has the fix
//   (default)                      the caption says "修正後"; Claude Code's
//                                  screen appears and it answers
// macOS and Windows never had the bug: there both builds are checked the
// second way.

const run = promisify(execFile)
const BEFORE = process.env.TASKCHUTE_RECORD_BUILD === "before"
const WINDOWS = process.platform === "win32"
const PLATFORM = WINDOWS ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux"
/** The bug: only the build before the fix, only on Linux. */
const EXPECT_EMPTY = BEFORE && process.platform === "linux"

const TASK = "カモノハシを調べる"
const taskPath = `${TASK_FOLDER}/${TASK}.md`
const PROMPT = "カモノハシを一言で説明して"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g")
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?<>=]*[A-Za-z]`, "g")

function localDateKey(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Removes the Claude Code sessions an earlier recording left for this throwaway vault. */
function removeSessionsOf(vault: string): void {
  const project = path.join(os.homedir(), ".claude", "projects", vault.replace(/[^a-zA-Z0-9]/g, "-"))
  if (!fs.existsSync(project)) return
  for (const name of fs.readdirSync(project)) {
    const file = path.join(project, name)
    if (!name.endsWith(".jsonl") || !fs.statSync(file).isFile()) continue
    if (fs.readFileSync(file, "utf8").includes(`"cwd":${JSON.stringify(vault)}`)) fs.rmSync(file)
  }
}

/**
 * What the task's terminal has received from the CLI so far, without spacing.
 * Read from the run's transcript, which `script` writes as it relays: while
 * the relay is stuck the file does not grow, just as the screen stays empty.
 */
async function received(page: Page): Promise<string> {
  const transcript = await page.evaluate(
    ([id, task]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager?: { getRuns(): Array<{ taskPath: string; transcriptPath?: string }> }
      }
      return plugin.aiTaskManager?.getRuns().find((candidate) => candidate.taskPath === task)?.transcriptPath ?? null
    },
    [PLUGIN_ID, taskPath] as const,
  )
  if (!transcript || !fs.existsSync(transcript) || fs.statSync(transcript).size === 0) {
    // No transcript file (Windows): the terminal's rows, when it draws them as elements.
    const drawn = await page.evaluate(() => {
      const terminals = document.querySelectorAll(".ai-run-pane .xterm-rows")
      return terminals[terminals.length - 1]?.textContent ?? ""
    })
    return drawn.replace(/\s+/g, "")
  }
  const raw = fs.readFileSync(transcript, "utf8")
  // The first line is script's own header (it repeats the command, prompt included).
  const body = raw.slice(raw.indexOf("\n") + 1)
  return body.replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(/\s+/g, "")
}

const CLAUDE_SCREEN = "ClaudeCode"

test("linux-terminal-real-cli", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  removeSessionsOf(vault)

  const claudePath = (await run(WINDOWS ? "where" : "which", ["claude"])).stdout.split(/\r?\n/)[0]?.trim() ?? ""
  if (!claudePath) throw new Error("This scenario needs the Claude Code CLI (`claude`) on PATH, signed in.")
  await enableAiTasks(page, claudePath, "terminal")
  await createNotes(page, {
    [taskPath]: ["---", "tags:", "  - task", `target_date: "${localDateKey()}"`, "ai_task: true", "ai_task_host: claude", "---", "", "## Prompt", "", PROMPT, ""].join("\n"),
  })
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await expect.poll(() => rowState(row)).toBe("idle")

  await recorder.start(
    `${BEFORE ? "修正前" : "修正後"}：${PLATFORM} で、AI タスクを本物の Claude Code で実行する`,
    { sub: "CLI は本物。ターミナルで動かします" },
  )

  await recorder.chapter("① AI タスクを開始する", { sub: "AI 実行パネルに、ターミナルのタブが開く" })
  await recorder.click(row.locator(".play-stop-button"))
  await expect.poll(() => rowState(row)).toBe("running")
  await page.locator(".ai-run-pane .xterm").first().waitFor()
  await recorder.click(page.locator(".ai-run-pane__expand"))

  if (EXPECT_EMPTY) {
    await recorder.chapter("② 10秒待つ", { sub: "Claude Code の画面が出ない。ターミナルは空のまま" })
    await recorder.pause(10_000)
    // Nothing of Claude Code's screen has come through.
    expect(await received(page)).not.toContain(CLAUDE_SCREEN)
    const stuckAt = (await received(page)).length

    await recorder.chapter("③ Enter を1回押す", { sub: "たまっていた出力が、まとめて流れてくる" })
    await recorder.click(page.locator(".ai-run-pane .xterm").first())
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await received(page)).length, { timeout: 10_000 }).toBeGreaterThan(stuckAt)
    await recorder.pause(4000)
    return
  }

  await recorder.chapter("② そのまま待つ", { sub: "Claude Code の画面が出る" })
  await expect.poll(() => received(page), { timeout: 30_000 }).toMatch(/trust|ClaudeCode/)
  if (!(await received(page)).includes(CLAUDE_SCREEN)) {
    await recorder.caption("② そのまま待つ", { sub: "初めてのフォルダなので、信頼するか聞かれる。Enter で進める" })
    await recorder.click(page.locator(".ai-run-pane .xterm").first())
    await page.keyboard.press("Enter")
  }
  await expect.poll(() => received(page), { timeout: 30_000 }).toContain(CLAUDE_SCREEN)

  await recorder.chapter("③ 答えが返る", { sub: "指示がそのまま渡り、Claude Code が答える" })
  // The prompt on Claude Code's screen, then an answer about the animal.
  await expect.poll(() => received(page), { timeout: 60_000 }).toContain(PROMPT)
  await expect
    .poll(async () => (await received(page)).split(PROMPT).pop() ?? "", { timeout: 90_000 })
    .toMatch(/哺乳|卵|くちばし|オーストラリア|動物|生き物/)
  await recorder.pause(4000)
})
