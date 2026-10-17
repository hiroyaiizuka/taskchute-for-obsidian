import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute } from "../helpers/aiTask"

// LEV-314: the AI pane gives the terminal room. By default it takes half of
// the view under the date row, with a slim header; full screen (⤢) is the
// whole view, date row included; collapsing from full screen leaves the
// header bar and the task list, and opening again returns to full screen.
test.use({ isolatedHome: true })

const SESSION = "11111111-1111-4111-8111-111111111111"

/** One Claude Code session in the vault, and a stand-in CLI to resume it with. */
function prepare(home: string, vault: string, bin: string): string {
  const file = path.join(home, ".claude", "projects", "p", `${SESSION}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: vault, message: { role: "user", content: "README を読んで" } },
      { type: "assistant", cwd: vault, message: { role: "assistant", content: [{ type: "text", text: "読みました。" }] } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n",
  )
  fs.mkdirSync(bin, { recursive: true })
  const claude = path.join(bin, "claude")
  fs.writeFileSync(claude, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 })
  return claude
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
      view: height(".taskchute-view-root"),
      dateRow: height(".top-bar-container"),
      main: height(".main-container"),
      mainTop: Math.round(document.querySelector(".main-container")?.getBoundingClientRect().top ?? 0),
      paneTop: Math.round(document.querySelector(".ai-pane-container")?.getBoundingClientRect().top ?? 0),
      pane: height(".ai-pane-container"),
      header: height(".ai-run-pane__header"),
      taskList: height(".task-list-container"),
      terminal: height(".ai-run-pane .xterm-screen"),
    }
  })
}

test("the pane takes half the view, full screen takes all of it, and collapsing from full screen keeps the header", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  await enableAiTasks(page, prepare(home!, vault, testInfo.outputPath("bin")))
  await openTaskChute(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(
    async ([id, session, cwd]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { resumeAgentSession(options: unknown): Promise<unknown> }
      }
      await plugin.aiTaskManager.resumeAgentSession({ host: "claude", sessionId: session, cwd, name: "probe" })
    },
    [PLUGIN_ID, SESSION, vault] as const,
  )
  await page.locator(".ai-run-pane .xterm").first().waitFor()

  // Default: half of the area under the date row; a slim header.
  await expect.poll(async () => (await layout(page)).pane).toBeGreaterThan(0)
  const normal = await layout(page)
  expect(normal.dateRow).toBeGreaterThan(0)
  expect(normal.pane / normal.main).toBeGreaterThan(0.47)
  expect(normal.pane / normal.main).toBeLessThan(0.53)
  expect(normal.header).toBeLessThanOrEqual(25)

  // Full screen: the whole view inside Obsidian's own padding, the date row included.
  await page.locator(".ai-run-pane__expand").click()
  await expect.poll(async () => (await layout(page)).dateRow).toBe(0)
  const full = await layout(page)
  // The date row and its margin go: at least the row's own height is gained.
  expect(full.main).toBeGreaterThanOrEqual(normal.main + normal.dateRow)
  expect(full.paneTop).toBe(full.mainTop)
  expect(full.pane).toBe(full.main)
  expect(full.terminal).toBeGreaterThan(normal.terminal)

  // Collapsed from full screen: the header bar stays, the task list and the date row come back.
  await page.locator(".ai-run-pane__collapse").click()
  await expect.poll(async () => (await layout(page)).dateRow).toBeGreaterThan(0)
  const collapsed = await layout(page)
  expect(collapsed.header).toBeGreaterThan(0)
  expect(collapsed.taskList).toBeGreaterThan(collapsed.pane)

  // Opened again: back to full screen.
  await page.locator(".ai-run-pane__collapse").click()
  await expect.poll(async () => (await layout(page)).dateRow).toBe(0)
  expect((await layout(page)).pane).toBe(full.main)

  // ⤢ again: back to half, the date row returns.
  await page.locator(".ai-run-pane__expand").click()
  await expect.poll(async () => (await layout(page)).dateRow).toBeGreaterThan(0)
  const back = await layout(page)
  expect(back.pane / back.main).toBeGreaterThan(0.47)
  expect(back.pane / back.main).toBeLessThan(0.53)
})
