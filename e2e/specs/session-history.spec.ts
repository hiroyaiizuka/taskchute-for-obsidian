import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute } from "../helpers/aiTask"

// LEV-320: past agent sessions of the vault's folder, listed in the AI pane
// and resumed in a new terminal tab. Obsidian gets a home folder of its own,
// so the test never touches the real ~/.claude, ~/.codex or ~/.cursor.
test.use({ isolatedHome: true })

const jsonl = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n"

function write(file: string, content: string, mtime: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  fs.utimesSync(file, mtime, mtime)
}

/** Sessions of Claude Code, Codex and Cursor in the vault, and one elsewhere. */
function writeSessions(home: string, vault: string) {
  const now = Date.now() / 1000
  const claude = (id: string, cwd: string, title: string, ask: string, age: number) =>
    write(
      path.join(home, ".claude", "projects", "p", `${id}.jsonl`),
      jsonl(
        { type: "user", cwd, message: { role: "user", content: ask } },
        { type: "ai-title", aiTitle: title },
        { type: "assistant", cwd, message: { role: "assistant", content: [{ type: "text", text: `Answered: ${ask}` }] } },
      ),
      now - age,
    )
  claude("11111111-1111-4111-8111-111111111111", vault, "引っ越しの準備", "やることを洗い出して", 60)
  claude("22222222-2222-4222-8222-222222222222", vault, "デプロイの失敗を調べる", "ステージングのデプロイが失敗した", 3600)
  claude("33333333-3333-4333-8333-333333333333", path.join(home, "elsewhere"), "関係ないプロジェクト", "hello", 120)
  fs.mkdirSync(path.join(home, "elsewhere"), { recursive: true })

  const codexId = "01a11df0-5a7f-7a90-a802-5ac63ec161ae"
  write(path.join(home, ".codex", "session_index.jsonl"), jsonl({ id: codexId, thread_name: "README の要約" }), now - 7200)
  write(
    path.join(home, ".codex", "sessions", "2026", "10", "09", `rollout-2026-10-09T08-54-13-${codexId}.jsonl`),
    jsonl(
      { type: "session_meta", payload: { id: codexId, cwd: vault } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "README.md を読んで" }] } },
    ),
    now - 7200,
  )
  write(
    path.join(home, ".cursor", "chats", "w", "cursor-chat-1", "meta.json"),
    JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd: vault, updatedAtMs: (now - 10800) * 1000 }),
    now - 10800,
  )
}

/** A stand-in Claude CLI that records the arguments it was started with. */
function writeArgvRecorder(dir: string): { bin: string; argvFile: string } {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, "claude")
  const argvFile = path.join(dir, "argv.txt")
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexec sleep 60\n`, { mode: 0o755 })
  return { bin, argvFile }
}

const rows = (page: Page) => page.locator(".ai-session-history__row")
const rowTitles = (page: Page) => page.locator(".ai-session-history__row .ai-session-history__title")

async function openHistory(page: Page) {
  await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-session-history`)
  await expect(page.locator(".ai-run-pane__sidebar-history-view")).toBeVisible()
}

test("lists the vault's sessions of every agent, searches them, archives and restores", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  writeSessions(home!, vault)
  await enableAiTasks(page, writeArgvRecorder(testInfo.outputPath("bin")).bin)
  await openTaskChute(page)
  await openHistory(page)

  // Newest first; the session that ran elsewhere is not listed.
  await expect(rowTitles(page)).toHaveText(["引っ越しの準備", "デプロイの失敗を調べる", "README の要約", path.basename(vault)])
  await expect(page.locator('.ai-session-history__row[data-session-host="codex"]')).toHaveCount(1)
  await expect(page.locator('.ai-session-history__row[data-session-host="cursor"]')).toHaveCount(1)

  // Search: every word, in the title or the first and last messages.
  await page.locator(".ai-session-history__search").fill("ステージング デプロイ")
  await expect(rowTitles(page)).toHaveText(["デプロイの失敗を調べる"])
  await page.locator(".ai-session-history__search").fill("")
  await expect(rows(page)).toHaveCount(4)

  // Archive: off the list, into the archived view, and back.
  await page.locator('.ai-session-history__row', { hasText: "引っ越しの準備" }).locator(".ai-session-history__archive").click()
  await expect(rowTitles(page)).toHaveText(["デプロイの失敗を調べる", "README の要約", path.basename(vault)])
  await page.locator(".ai-session-history__archived").click()
  await expect(rowTitles(page)).toHaveText(["引っ越しの準備"])
  await page.locator('.ai-session-history__row', { hasText: "引っ越しの準備" }).locator(".ai-session-history__archive").click()
  await page.locator(".ai-session-history__archived").click()
  await expect(rows(page)).toHaveCount(4)
})

test("resumes a session in a new terminal tab with the CLI's resume arguments", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  writeSessions(home!, vault)
  const recorder = writeArgvRecorder(testInfo.outputPath("bin"))
  await enableAiTasks(page, recorder.bin)
  await openTaskChute(page)
  await openHistory(page)

  await page.locator('.ai-session-history__row', { hasText: "引っ越しの準備" }).locator(".ai-session-history__resume").click()

  await expect.poll(() => (fs.existsSync(recorder.argvFile) ? fs.readFileSync(recorder.argvFile, "utf8").trim().split("\n") : []), {
    timeout: 20_000,
  }).toEqual(["--resume", "11111111-1111-4111-8111-111111111111"])
  // A tab of its own, attached to no task.
  const runs = await page.evaluate((id) => {
    const plugin = window.app.plugins.plugins[id] as { aiTaskManager: { getRuns(): Array<{ host: string; taskPath: string; taskName: string; cwd?: string }> } }
    return plugin.aiTaskManager.getRuns().map((run) => ({ host: run.host, taskPath: run.taskPath, taskName: run.taskName, cwd: run.cwd }))
  }, PLUGIN_ID)
  expect(runs).toEqual([{ host: "shell", taskPath: "", taskName: "👑 引っ越しの準備", cwd: vault }])
})
