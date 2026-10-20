import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, enableAiTasks, openTaskChute, taskRow, todayKey, writeFakeClaude } from "../helpers/aiTask"

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

/** What each Claude Code session says halfway through, away from its first and last messages. */
const MIDDLE: Record<string, string> = {
  "11111111-1111-4111-8111-111111111111": "粗大ごみの回収を予約する",
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
        // Mid-conversation: only full-text search finds what is said here.
        { type: "user", cwd, message: { role: "user", content: `Also: ${MIDDLE[id] ?? "nothing else"}` } },
        { type: "assistant", cwd, message: { role: "assistant", content: [{ type: "text", text: "Noted." }] } },
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

  // Search: every word, in the title or anywhere in the conversation.
  await page.locator(".ai-session-history__search").fill("ステージング デプロイ")
  await expect(rowTitles(page)).toHaveText(["デプロイの失敗を調べる"])
  await page.locator(".ai-session-history__search").fill("粗大ごみ 予約")
  await expect(rowTitles(page)).toHaveText(["引っ越しの準備"])
  await expect(rows(page).first().locator(".ai-session-history__snippet")).toContainText("粗大ごみの回収を予約する")
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

/** An AI task note for today, ready to start from its row. */
async function createAiTask(page: Page, name: string): Promise<string> {
  const taskPath = `${TASK_FOLDER}/${name}.md`
  const note = [
    "---",
    "tags:",
    "  - task",
    `target_date: "${await todayKey(page)}"`,
    "ai_task: true",
    "ai_task_host: claude",
    "---",
    "",
    "## Prompt",
    "",
    `${name}.`,
    "",
  ].join("\n")
  await page.evaluate(
    async ([folder, file, content]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(file, content)
    },
    [TASK_FOLDER, taskPath, note] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as {
      metadataCache: { getCache(path: string): { frontmatter?: unknown } | null }
    }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, taskPath)
  return taskPath
}

/** The id of the run the history resumed (a terminal of its own, named after the session). */
async function resumedRunId(page: Page, name: string): Promise<string | null> {
  return page.evaluate(
    ([id, taskName]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { getRuns(): Array<{ id: string; host: string; taskName: string }> }
      }
      return plugin.aiTaskManager.getRuns().find((run) => run.host === "shell" && run.taskName === taskName)?.id ?? null
    },
    [PLUGIN_ID, name] as const,
  )
}

/** The runs whose tabs the visible panel lists, left to right. */
async function tabRunIds(page: Page): Promise<string[]> {
  return page
    .locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__tabs .ai-run-pane__tab")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-run-id") ?? ""))
}

// LEV-381: a resumed session joins the task that was showing, as + does: a new
// tab next to the task's own, still there after showing another task and
// coming back.
test("a resumed session opens as a new tab beside the task's, and stays when switching tasks", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  writeSessions(home!, vault)
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"), "terminal")
  const journal = await createAiTask(page, "AI Weekly Journal")
  const review = await createAiTask(page, "AI Weekly Review")
  await openTaskChute(page)

  const sidebarRow = (name: string) => page.locator(".ai-run-pane__run", { hasText: name })
  await taskRow(page, journal).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await taskRow(page, review).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Review")).toHaveCount(1)
  const journalRunId = (await sidebarRow("AI Weekly Journal").getAttribute("data-run-id"))!

  // AI Weekly Journal is showing; resume a session from the history.
  await sidebarRow("AI Weekly Journal").click()
  await expect.poll(() => tabRunIds(page)).toEqual([journalRunId])
  await openHistory(page)
  await page.locator(".ai-session-history__row", { hasText: "引っ越しの準備" }).locator(".ai-session-history__resume").click()
  await expect.poll(() => resumedRunId(page, "👑 引っ越しの準備"), { timeout: 20_000 }).not.toBeNull()
  const resumed = (await resumedRunId(page, "👑 引っ越しの準備"))!

  // A new tab beside the task's, and it is the one shown.
  await expect.soft.poll(() => tabRunIds(page)).toEqual([journalRunId, resumed])
  await expect.soft(page.locator(`.ai-run-pane__tab[data-run-id="${resumed}"]`)).toHaveAttribute("aria-selected", "true")

  // Back to the task list, over to AI Weekly Review, and back again: still there.
  await page.locator(".ai-run-pane__sidebar-history").click()
  await sidebarRow("AI Weekly Review").click()
  await expect.poll(() => tabRunIds(page)).not.toContain(journalRunId)
  await sidebarRow("AI Weekly Journal").click()
  await expect.poll(() => tabRunIds(page)).toEqual([journalRunId, resumed])
  await expect(page.locator(`.ai-run-pane__tab[data-run-id="${resumed}"]`)).toHaveAttribute("aria-selected", "true")
})

/** The status of each run, null once the manager has let it go. */
async function runStatuses(page: Page, runIds: string[]): Promise<Array<string | null>> {
  return page.evaluate(
    ([id, ids]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { getRun(runId: string): { status: string } | undefined }
      }
      return ids.map((runId) => plugin.aiTaskManager.getRun(runId)?.status ?? null)
    },
    [PLUGIN_ID, runIds] as const,
  )
}

/** The terminals opened beside a run (+, split, or resumed), oldest first. */
async function childRunIds(page: Page, parentRunId: string): Promise<string[]> {
  return page.evaluate(
    ([id, parent]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { getRuns(): Array<{ id: string; parentRunId?: string; startedAt: number }> }
      }
      return plugin.aiTaskManager
        .getRuns()
        .filter((run) => run.parentRunId === parent)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((run) => run.id)
    },
    [PLUGIN_ID, parentRunId] as const,
  )
}

// LEV-382: the × on a task's own tab closes that tab only. A resumed session
// and a + terminal opened beside it keep running, and the task's row stays so
// they can be shown again; the row goes with the last of them.
test("closing a task's own tab keeps the tabs opened beside it, and its row", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  writeSessions(home!, vault)
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"), "terminal")
  const journal = await createAiTask(page, "AI Weekly Journal")
  const review = await createAiTask(page, "AI Weekly Review")
  await openTaskChute(page)

  const sidebarRow = (name: string) => page.locator(".ai-run-pane__run", { hasText: name })
  // The × shows on hover, as for a person moving the pointer over the tab.
  const closeTab = async (runId: string) => {
    const tab = page.locator(`.ai-run-pane__tab[data-run-id="${runId}"]`)
    await tab.hover()
    await tab.locator(".ai-run-pane__tab-close").click()
  }
  await taskRow(page, journal).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await taskRow(page, review).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Review")).toHaveCount(1)
  const journalRunId = (await sidebarRow("AI Weekly Journal").getAttribute("data-run-id"))!

  // AI Weekly Journal, a session resumed beside it, and a + terminal.
  await sidebarRow("AI Weekly Journal").click()
  await expect.poll(() => tabRunIds(page)).toEqual([journalRunId])
  await openHistory(page)
  await page.locator(".ai-session-history__row", { hasText: "引っ越しの準備" }).locator(".ai-session-history__resume").click()
  await expect.poll(() => childRunIds(page, journalRunId), { timeout: 20_000 }).toHaveLength(1)
  const [resumed] = await childRunIds(page, journalRunId)
  await page.locator(".ai-run-pane__sidebar-history").click()
  await page.locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__add").click()
  await expect.poll(() => childRunIds(page, journalRunId), { timeout: 20_000 }).toHaveLength(2)
  const terminal = (await childRunIds(page, journalRunId))[1]
  await expect.poll(() => tabRunIds(page)).toEqual([journalRunId, resumed, terminal])

  // × on the task's own tab: that tab goes; the other two and the row stay.
  await closeTab(journalRunId)
  await expect.soft.poll(() => tabRunIds(page), { timeout: 20_000 }).toEqual([resumed, terminal])
  await expect.soft(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await expect.soft.poll(() => runStatuses(page, [resumed, terminal])).toEqual(["running", "running"])

  // Over to AI Weekly Review and back: still there.
  await sidebarRow("AI Weekly Review").click()
  await expect.poll(() => tabRunIds(page)).not.toContain(resumed)
  await sidebarRow("AI Weekly Journal").click()
  await expect.poll(() => tabRunIds(page)).toEqual([resumed, terminal])

  // The row goes with the last tab.
  await closeTab(terminal)
  await expect.poll(() => tabRunIds(page), { timeout: 20_000 }).toEqual([resumed])
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await closeTab(resumed)
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(0, { timeout: 20_000 })
  await expect(sidebarRow("AI Weekly Review")).toHaveCount(1)
})

// LEV-383: the × on a task's row asks first, then closes every tab of the row
// — the task's own, a session resumed beside it and a + terminal — and the
// row with them. Cancel and Escape leave everything as it was.
test("the row's × asks first, then closes every tab of the row", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  writeSessions(home!, vault)
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"), "terminal")
  const journal = await createAiTask(page, "AI Weekly Journal")
  const review = await createAiTask(page, "AI Weekly Review")
  await openTaskChute(page)

  const sidebarRow = (name: string) => page.locator(".ai-run-pane__run", { hasText: name })
  const dialog = page.locator(".modal-container .taskchute-confirm-modal")
  // The × shows on hover, as for a person moving the pointer over the row.
  const pressRowClose = async (name: string) => {
    await sidebarRow(name).hover()
    await sidebarRow(name).locator(".ai-run-pane__run-close").click()
  }
  await taskRow(page, journal).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await taskRow(page, review).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Review")).toHaveCount(1)
  const journalRunId = (await sidebarRow("AI Weekly Journal").getAttribute("data-run-id"))!
  const reviewRunId = (await sidebarRow("AI Weekly Review").getAttribute("data-run-id"))!

  // AI Weekly Journal, a session resumed beside it, and a + terminal.
  await sidebarRow("AI Weekly Journal").click()
  await openHistory(page)
  await page.locator(".ai-session-history__row", { hasText: "引っ越しの準備" }).locator(".ai-session-history__resume").click()
  await expect.poll(() => childRunIds(page, journalRunId), { timeout: 20_000 }).toHaveLength(1)
  await page.locator(".ai-run-pane__sidebar-history").click()
  await page.locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__add").click()
  await expect.poll(() => childRunIds(page, journalRunId), { timeout: 20_000 }).toHaveLength(2)
  const [resumed, terminal] = await childRunIds(page, journalRunId)
  const rowRunIds = [journalRunId, resumed, terminal]
  await expect.poll(() => tabRunIds(page)).toEqual(rowRunIds)

  // The row's ×: a dialog naming the task and counting its three tabs (each
  // listed under the name its tab shows, which for a terminal follows what
  // runs in it). Cancel keeps all.
  await pressRowClose("AI Weekly Journal")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Close "AI Weekly Journal"?')
  await expect(dialog).toContainText("This closes all 3 of this row's tabs.")
  await expect(dialog).toContainText("• AI Weekly Journal (running)")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => runStatuses(page, rowRunIds)).toEqual(["running", "running", "running"])
  await expect.poll(() => tabRunIds(page)).toEqual(rowRunIds)

  // Escape is a cancel too.
  await pressRowClose("AI Weekly Journal")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => runStatuses(page, rowRunIds)).toEqual(["running", "running", "running"])

  // Close all: every tab of the row goes, and the row with them.
  await pressRowClose("AI Weekly Journal")
  await dialog.getByRole("button", { name: "Close all" }).click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => runStatuses(page, rowRunIds), { timeout: 20_000 }).toEqual([null, null, null])
  // The other task is untouched.
  await expect(sidebarRow("AI Weekly Review")).toHaveCount(1)
  await expect.poll(() => runStatuses(page, [reviewRunId])).toEqual(["running"])
})

// LEV-384: once the pane is built again (the view reopened, Obsidian or the
// plugin reloaded), only the task it shows has a terminal on screen. Closing
// that task moves on to the other one, whose terminal must show at once —
// not stay blank until its row is clicked.
test("closing the task on screen shows the next task's terminal at once", async ({ obsidian }, testInfo) => {
  const { page } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"), "terminal")
  const journal = await createAiTask(page, "AI Weekly Journal")
  const review = await createAiTask(page, "AI Weekly Review")
  await openTaskChute(page)

  const sidebarRow = (name: string) => page.locator(".ai-run-pane__run", { hasText: name })
  const terminalOf = (runId: string) => page.locator(`.ai-run-pane__body[data-run-id="${runId}"] .xterm`)
  await taskRow(page, journal).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await taskRow(page, review).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Review")).toHaveCount(1)
  const journalRunId = (await sidebarRow("AI Weekly Journal").getAttribute("data-run-id"))!
  const reviewRunId = (await sidebarRow("AI Weekly Review").getAttribute("data-run-id"))!

  // Build the pane again: only the task it shows gets a terminal.
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await sidebarRow("AI Weekly Journal").click()
  await expect(terminalOf(journalRunId)).toBeVisible()
  await expect(terminalOf(reviewRunId)).toHaveCount(0)

  // Close it: AI Weekly Review comes up with its terminal, with no click.
  const journalTab = page.locator(`.ai-run-pane__tab[data-run-id="${journalRunId}"]`)
  await journalTab.hover()
  await journalTab.locator(".ai-run-pane__tab-close").click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => tabRunIds(page)).toEqual([reviewRunId])
  await expect(terminalOf(reviewRunId)).toBeVisible()
})

// LEV-385: with no task running, a session resumed from the history and a +
// terminal opened beside it belong to no task. Starting a task afterwards
// switches the pane to that task; the terminals must keep a row of their own
// to come back to (and to close), not run on with no way back.
test("terminals opened with no task keep a row of their own once a task starts", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  writeSessions(home!, vault)
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"), "terminal")
  const journal = await createAiTask(page, "AI Weekly Journal")
  await openTaskChute(page)

  const runRow = (runId: string) => page.locator(`.ai-run-pane__run[data-run-id="${runId}"]`)
  const sidebarRow = (name: string) => page.locator(".ai-run-pane__run", { hasText: name })
  const dialog = page.locator(".modal-container .taskchute-confirm-modal")

  // Nothing running: resume a session, then + beside it.
  await openHistory(page)
  await page.locator(".ai-session-history__row", { hasText: "引っ越しの準備" }).locator(".ai-session-history__resume").click()
  await expect.poll(() => resumedRunId(page, "👑 引っ越しの準備"), { timeout: 20_000 }).not.toBeNull()
  const resumed = (await resumedRunId(page, "👑 引っ越しの準備"))!
  await page.locator(".ai-run-pane__sidebar-history").click()
  await page.locator(".ai-run-pane__panel:not([hidden]) .ai-run-pane__add").click()
  await expect.poll(() => childRunIds(page, resumed), { timeout: 20_000 }).toHaveLength(1)
  const [terminal] = await childRunIds(page, resumed)
  await expect.poll(() => tabRunIds(page)).toEqual([resumed, terminal])
  // The terminals have a row from the start.
  await expect.soft(runRow(resumed)).toHaveCount(1)

  // A task starts and the pane shows it, with no click.
  await taskRow(page, journal).locator(".play-stop-button").click()
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  const journalRunId = (await sidebarRow("AI Weekly Journal").getAttribute("data-run-id"))!
  await expect.poll(() => tabRunIds(page)).toEqual([journalRunId])
  await expect(sidebarRow("AI Weekly Journal")).toHaveAttribute("aria-selected", "true")

  // The terminals' row is still there, and brings them back.
  await expect(runRow(resumed)).toHaveCount(1)
  await expect(runRow(resumed)).toHaveAttribute("aria-selected", "false")
  await runRow(resumed).click()
  await expect.poll(() => tabRunIds(page)).toEqual([resumed, terminal])
  await expect(runRow(resumed)).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => runStatuses(page, [resumed, terminal])).toEqual(["running", "running"])
  await sidebarRow("AI Weekly Journal").click()
  await expect.poll(() => tabRunIds(page)).toEqual([journalRunId])

  // Its × closes both terminals and the row; the task is untouched.
  await runRow(resumed).hover()
  await runRow(resumed).locator(".ai-run-pane__run-close").click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("This closes all 2 of this row's tabs.")
  await dialog.getByRole("button", { name: "Close all" }).click()
  await expect(runRow(resumed)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => runStatuses(page, [resumed, terminal]), { timeout: 20_000 }).toEqual([null, null])
  await expect(sidebarRow("AI Weekly Journal")).toHaveCount(1)
  await expect.poll(() => runStatuses(page, [journalRunId])).toEqual(["running"])
})
