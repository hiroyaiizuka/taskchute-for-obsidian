import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { PLUGIN_ID, enableAiTasks, openTaskChute } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"

// LEV-320: the AI pane's session history. Past agent sessions of the vault's
// folder are listed, searched, archived and resumed in a new terminal tab.
// Follows the issue's list, top to bottom.
//
// Nothing is faked: before the recording starts, the real CLIs of whoever
// records are run once each in the vault (Claude Code twice; Codex and Cursor
// when they are installed), and the recording resumes a Claude Code session
// with the real CLI. The CLIs must be signed in, and each run spends a request.
//
// Record this where the terminal shows a real CLI: macOS or Windows. On Linux
// the resumed CLI's screen stays empty (a known terminal bug, LEV-313), and
// the scenario stops at the resume scene.

const run = promisify(execFile)

const README = "# 引っ越しメモ\n\n- 10月20日に引っ越す\n- 電気・ガス・水道の手続きを10月15日までに済ませる\n- 郵便の転送届を出す\n"
const PLATYPUS_ASK = "カモノハシを一言で説明して"
const MOVE_ASK = "README.md を読んで、引っ越しまでにやることを3行でまとめて"
const CURSOR_ASK = "README.md の内容を英語に訳して"
const CODEX_ASK = "README.md を読んで、手続きの締め切りだけを教えて"
const FOLLOW_UP = "さっきのまとめを1行にして"

/**
 * Removes the sessions an earlier recording left for this vault. The vault is
 * a throwaway folder at the same path every time, so without this the list
 * grows by three on each run. Only sessions whose folder is this vault go.
 */
function removeSessionsOf(vault: string): void {
  const claudeProject = path.join(os.homedir(), ".claude", "projects", vault.replace(/[^a-zA-Z0-9]/g, "-"))
  if (fs.existsSync(claudeProject)) {
    for (const name of fs.readdirSync(claudeProject)) {
      const file = path.join(claudeProject, name)
      if (!name.endsWith(".jsonl") || !fs.statSync(file).isFile()) continue
      if (fs.readFileSync(file, "utf8").includes(`"cwd":${JSON.stringify(vault)}`)) fs.rmSync(file)
    }
  }
  const codexSessions = path.join(os.homedir(), ".codex", "sessions")
  if (fs.existsSync(codexSessions)) {
    for (const entry of fs.readdirSync(codexSessions, { recursive: true, encoding: "utf8" })) {
      const file = path.join(codexSessions, entry)
      if (!entry.endsWith(".jsonl") || !fs.statSync(file).isFile()) continue
      // The folder is in the first line (session_meta).
      const head = Buffer.alloc(8192)
      const handle = fs.openSync(file, "r")
      const read = fs.readSync(handle, head, 0, head.length, 0)
      fs.closeSync(handle)
      if (head.subarray(0, read).toString("utf8").includes(`"cwd":${JSON.stringify(vault)}`)) fs.rmSync(file)
    }
  }
  const cursorChats = path.join(os.homedir(), ".cursor", "chats")
  if (!fs.existsSync(cursorChats)) return
  for (const workspace of fs.readdirSync(cursorChats)) {
    const workspaceDir = path.join(cursorChats, workspace)
    if (!fs.statSync(workspaceDir).isDirectory()) continue
    for (const chat of fs.readdirSync(workspaceDir)) {
      const meta = path.join(workspaceDir, chat, "meta.json")
      if (!fs.existsSync(meta)) continue
      try {
        const cwd = (JSON.parse(fs.readFileSync(meta, "utf8")) as { cwd?: unknown }).cwd
        if (cwd === vault) fs.rmSync(path.join(workspaceDir, chat), { recursive: true })
      } catch {
        // Not a chat this scenario wrote.
      }
    }
  }
}

const WINDOWS = process.platform === "win32"

/** The full path of a CLI on PATH, or null when it is not installed. */
async function locate(command: string): Promise<string | null> {
  try {
    const { stdout } = await run(WINDOWS ? "where" : "which", [command])
    return stdout.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

/** Runs a real CLI once in the vault, headless, so it leaves a session behind. */
async function seed(vault: string, command: string, args: string[]): Promise<void> {
  // Windows starts .cmd launchers through the shell, which splits on spaces.
  const argv = WINDOWS ? args.map((arg) => `"${arg}"`) : args
  await run(WINDOWS ? `"${command}"` : command, argv, {
    cwd: vault,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: WINDOWS,
  })
  // Sessions are listed newest first by file time: keep the order certain.
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g")
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?<>=]*[A-Za-z]`, "g")

/** What the resumed terminal has printed so far, without spacing (the terminal is a canvas). */
async function terminalText(page: Page): Promise<string> {
  const transcript = await page.evaluate((id) => {
    const plugin = window.app.plugins.plugins[id] as {
      aiTaskManager?: { getRuns(): Array<{ host: string; status: string; transcriptPath?: string }> }
    }
    return plugin.aiTaskManager?.getRuns().find((run) => run.host === "shell")?.transcriptPath ?? null
  }, PLUGIN_ID)
  if (!transcript || !fs.existsSync(transcript) || fs.statSync(transcript).size === 0) {
    // No transcript file (Windows): the terminal's rows, when it draws them as elements.
    const drawn = await page.evaluate(() => {
      const terminals = document.querySelectorAll(".ai-run-pane .xterm-rows")
      return terminals[terminals.length - 1]?.textContent ?? ""
    })
    return drawn.replace(/\s+/g, "")
  }
  // A full-screen CLI places words with cursor movements: drop the control
  // sequences and the spacing, and what is left reads as the text on screen.
  return fs.readFileSync(transcript, "utf8").replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(/\s+/g, "")
}

const view = (page: Page) => page.locator(".ai-run-pane__sidebar-history-view")
const rows = (page: Page) => view(page).locator(".ai-session-history__row")
const row = (page: Page, text: string) => rows(page).filter({ hasText: text })
const hosts = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.sessionHost))

test("session-history", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())

  // Off camera: real sessions in the vault, oldest first.
  const claudePath = await locate("claude")
  if (!claudePath) throw new Error("This scenario needs the Claude Code CLI (`claude`) on PATH, signed in.")
  const cursorPath = (await locate("cursor-agent")) ?? (await locate("agent"))
  const codexPath = await locate("codex")
  removeSessionsOf(vault)
  fs.writeFileSync(path.join(vault, "README.md"), README)
  if (cursorPath) await seed(vault, cursorPath, ["-p", "--trust", CURSOR_ASK])
  if (codexPath) await seed(vault, codexPath, ["exec", "--skip-git-repo-check", CODEX_ASK])
  await seed(vault, claudePath, ["-p", PLATYPUS_ASK])
  await seed(vault, claudePath, ["-p", MOVE_ASK])
  const others = [...(codexPath ? ["codex"] : []), ...(cursorPath ? ["cursor"] : [])]
  const all = ["claude", "claude", ...others]
  const agentNames = ["Claude Code", ...(codexPath ? ["Codex"] : []), ...(cursorPath ? ["Cursor"] : [])].join("・")

  // The plugin is given the CLI by its full path, as its settings would hold it.
  await enableAiTasks(page, claudePath, "terminal")
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)

  await recorder.start("AI のセッション履歴：過去のセッションを一覧して、続きから再開する", {
    sub: `本物の ${agentNames} を、この保管庫で動かしてあります`,
    say: "AI のセッション履歴です。過去のセッションを一覧して、続きから再開します。本物の CLI を、この保管庫で動かしてあります。",
  })

  await recorder.chapter("① コマンド「AI のセッション履歴を開く」で開く", {
    sub: "この保管庫で動かしたセッションが、新しい順に並ぶ",
  })
  await page.keyboard.press("Control+P")
  const prompt = page.locator(".prompt-input")
  await prompt.waitFor()
  await prompt.pressSequentially("セッション履歴", { delay: 80 })
  await recorder.pause(900)
  await page.keyboard.press("Enter")
  await expect(view(page)).toBeVisible()
  // Newest first, and only the sessions of this vault's folder.
  await expect.poll(() => hosts(page)).toEqual(all)
  await expect(rows(page).nth(0)).toContainText("引っ越し")
  await expect(rows(page).nth(1)).toContainText("カモノハシ")
  await recorder.click(page.locator(".ai-run-pane__expand"))

  await recorder.chapter(`② ${agentNames} のセッションが並ぶ`, {
    sub: "タイトルがまだないセッションは、最初の質問をタイトルにする",
    say: "エージェントごとのセッションが並びます。タイトルがまだないセッションは、最初の質問をタイトルにします。",
  })
  for (let index = 0; index < all.length; index += 1) {
    await recorder.hover(rows(page).nth(index))
    await recorder.pause(900)
  }
  if (codexPath) await expect(rows(page).nth(2)).toContainText("締め切り")
  // Cursor's chat is read from its own store: the title is what was asked.
  if (cursorPath) await expect(rows(page).nth(all.length - 1).locator(".ai-session-history__title")).toContainText("英語に訳して")

  await recorder.chapter("③ 検索する：「カモノハシ」", {
    sub: "タイトルと最初・最後のやり取りに、その単語を含むものだけ残る",
  })
  const search = view(page).locator(".ai-session-history__search")
  await recorder.click(search)
  await search.pressSequentially("カモノハシ", { delay: 110 })
  await expect.poll(() => rows(page).count()).toBe(1)
  await expect(rows(page).first()).toContainText("カモノハシ")
  await recorder.pause(1500)
  await search.fill("")
  await expect.poll(() => rows(page).count()).toBe(all.length)

  await recorder.chapter("④ アーカイブする", { sub: "一覧から外れる。CLI のファイルには触らない" })
  await recorder.hover(row(page, "カモノハシ"))
  await recorder.click(row(page, "カモノハシ").locator(".ai-session-history__archive"))
  await expect.poll(() => hosts(page)).toEqual(["claude", ...others])
  await expect(row(page, "カモノハシ")).toHaveCount(0)

  await recorder.chapter("⑤ アーカイブの表示に切り替えて、一覧に戻す", { sub: "元の一覧に戻る" })
  const archivedToggle = view(page).locator(".ai-session-history__archived")
  await recorder.click(archivedToggle)
  await expect.poll(() => rows(page).count()).toBe(1)
  await expect(rows(page).first()).toContainText("カモノハシ")
  await recorder.pause(1200)
  await recorder.click(rows(page).first().locator(".ai-session-history__archive"))
  await recorder.click(archivedToggle)
  await expect.poll(() => hosts(page)).toEqual(all)

  await recorder.chapter("⑥ 再開する", {
    sub: "新しいターミナルのタブで、Claude Code がそのセッションの続きから起動する",
    say: "再開します。新しいターミナルのタブで、クロードコードがそのセッションの続きから起動します。",
  })
  await recorder.hover(rows(page).nth(0))
  await recorder.click(rows(page).nth(0).locator(".ai-session-history__resume"))
  const runs = () =>
    page.evaluate((id) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { getRuns(): Array<{ host: string; taskPath: string; cwd?: string; mode?: string }> }
      }
      return plugin.aiTaskManager.getRuns().map((r) => ({ host: r.host, taskPath: r.taskPath, cwd: r.cwd, mode: r.mode }))
    }, PLUGIN_ID)
  // A tab of its own in the session's folder, attached to no task.
  await expect.poll(runs).toEqual([{ host: "shell", taskPath: "", cwd: vault, mode: "terminal" }])
  // Claude Code asks once whether to trust a folder it has not been in.
  await expect.poll(() => terminalText(page), { timeout: 40_000 }).toMatch(/trust|3行でまとめて/)
  if (!(await terminalText(page)).includes("3行でまとめて")) {
    await recorder.caption("⑥ 再開する", {
      sub: "初めてのフォルダなので、Claude Code が信頼するか聞く。Enter で進める",
      say: "初めてのフォルダなので、クロードコードが信頼するかを聞きます。エンターで進めます。",
    })
    await recorder.click(page.locator(".ai-run-pane .xterm").last())
    await page.keyboard.press("Enter")
  }
  // The earlier exchange is back on screen.
  await expect.poll(() => terminalText(page), { timeout: 40_000 }).toContain("3行でまとめて")
  await recorder.pause(2500)

  await recorder.chapter("⑦ 続けて話しかける：「さっきのまとめを1行にして」", {
    sub: "前の会話を覚えていて、その続きとして答える",
  })
  await recorder.click(page.locator(".ai-run-pane .xterm").last())
  const before = (await terminalText(page)).length
  await page.keyboard.type(FOLLOW_UP, { delay: 90 })
  await page.keyboard.press("Enter")
  // The answer draws on the first exchange: the move, which the follow-up does not name.
  await expect
    .poll(async () => (await terminalText(page)).slice(before).replace(FOLLOW_UP, ""), { timeout: 90_000 })
    .toMatch(/引っ越|10月/)
  await recorder.pause(4000)
})
