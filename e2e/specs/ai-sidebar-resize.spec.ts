import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute, writeNodeCli } from "../helpers/aiTask"

// LEV-375: the AI pane's left sidebar is resized by dragging its right edge,
// smoothly down to 35px; dragged past that it closes outright (the same state
// as its toggle), opens again at the width it had, and keeps that width per
// device.
test.use({ isolatedHome: true })

const SESSION = "22222222-2222-4222-8222-222222222222"
const WIDTH_KEY = "taskchute-plus.ai-pane-sidebar-width"

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
  return writeNodeCli(bin, "claude", "setTimeout(() => {}, 60_000)")
}

/** A box in CSS pixels, rounded. */
async function box(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
    }
  })
}

const sidebarWidth = (page: Page) => box(page, ".ai-run-pane__sidebar").then((b) => b.width)

const terminalWidth = (page: Page) =>
  page.locator(".ai-run-pane .xterm-screen").first().evaluate((el) => Math.round(el.getBoundingClientRect().width))

/** What the pointer would hit at (x, y): the splitter, or something else. */
const hitsSplitter = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => document.elementFromPoint(px, py)?.classList.contains("ai-run-pane__sidebar-resizer") ?? false,
    [x, y] as const,
  )

/** Press at (x, y), move to toX in a few steps, release. */
async function dragFrom(page: Page, x: number, y: number, toX: number) {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(toX, y, { steps: 8 })
  await page.mouse.up()
}

/**
 * Drag the splitter so the pointer lands `toX` px right of the sidebar's left
 * edge (the panels' left edge while it is closed), and wait for `settled`.
 * Each try starts from the geometry on screen then: on a shared desktop
 * another Obsidian window opening can take the pointer capture mid-drag,
 * which the splitter treats as a cancel.
 */
async function dragSplitterTo(page: Page, toX: number, settled: () => Promise<boolean>) {
  await expect(async () => {
    const closed = await page.locator(".ai-run-pane").evaluate((el) => el.classList.contains("is-sidebar-collapsed"))
    const row = await box(page, ".ai-run-pane__layout")
    const y = Math.round((row.top + row.bottom) / 2)
    const fromX = closed ? row.left + 3 : (await box(page, ".ai-run-pane__sidebar")).right
    await dragFrom(page, fromX, y, row.left + toX)
    await expect.poll(settled, { timeout: 2_000 }).toBe(true)
  }).toPass({ intervals: [250, 500, 1_000], timeout: 20_000 })
}

const isClosed = (page: Page) =>
  page.locator(".ai-run-pane").evaluate((el) => el.classList.contains("is-sidebar-collapsed"))

async function openPaneWithTerminal(page: Page, home: string, bin: string) {
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  await enableAiTasks(page, prepare(home, vault, bin))
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
}

test("dragging the sidebar's edge resizes it down to 35px, past that closes it, and the width outlives the view", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  await openPaneWithTerminal(page, home!, testInfo.outputPath("bin"))

  await expect(page.locator(".ai-run-pane__sidebar")).toBeVisible()
  expect(await sidebarWidth(page)).toBe(180)
  const before = await box(page, ".ai-run-pane__sidebar")
  const y = Math.round((before.top + before.bottom) / 2)
  // The splitter takes the pointer over the edge, terminal side included.
  expect(await hitsSplitter(page, before.right - 2, y)).toBe(true)
  expect(await hitsSplitter(page, before.right + 2, y)).toBe(true)

  // Wider by 80px: the sidebar follows, and the terminal gives up the room.
  const terminalBefore = await terminalWidth(page)
  await dragSplitterTo(page, 260, async () => (await sidebarWidth(page)) === 260)
  await expect.poll(() => terminalWidth(page)).toBeLessThan(terminalBefore)
  expect(await page.evaluate((key) => window.app.loadLocalStorage(key), WIDTH_KEY)).toBe(260)

  // Narrow, with no stop on the way: 60px, and the run list clips sideways
  // instead of scrolling.
  await dragSplitterTo(page, 60, async () => (await sidebarWidth(page)) === 60)
  const runs = await page.locator(".ai-run-pane__sidebar-runs").evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
  }))
  expect(runs.overflowX).toBe("hidden")
  expect(await page.locator(".ai-run-pane__sidebar").evaluate((el) => el.scrollLeft)).toBe(0)

  // The toolbar sheds the files and history buttons first: the toggle stays
  // whole inside the sidebar, and a click on it still closes and opens it.
  await expect(page.locator(".ai-run-pane__sidebar-history")).toBeHidden()
  await expect(page.locator(".ai-run-pane__sidebar-files")).toBeHidden()
  const toggleBox = await box(page, ".ai-run-pane__sidebar-toggle")
  const narrowSidebar = await box(page, ".ai-run-pane__sidebar")
  expect(toggleBox.width).toBe(24)
  expect(toggleBox.right).toBeLessThanOrEqual(narrowSidebar.right)
  await page.locator(".ai-run-pane__sidebar-toggle").click()
  await expect(page.locator(".ai-run-pane__sidebar")).toBeHidden()
  await page.locator(".ai-run-pane__sidebar-toggle").click()
  await expect.poll(() => sidebarWidth(page)).toBe(60)

  // Wide enough again, every button is back.
  await dragSplitterTo(page, 120, async () => (await sidebarWidth(page)) === 120)
  await expect(page.locator(".ai-run-pane__sidebar-history")).toBeVisible()
  await expect(page.locator(".ai-run-pane__sidebar-files")).toBeVisible()
  await dragSplitterTo(page, 60, async () => (await sidebarWidth(page)) === 60)

  // Past 35px from the sidebar's left edge: closed, as by its toggle.
  await dragSplitterTo(page, 20, () => isClosed(page))
  await expect(page.locator(".ai-run-pane__sidebar")).toBeHidden()
  await expect(page.locator(".ai-run-pane")).toHaveClass(/is-sidebar-collapsed/)
  await expect(page.locator(".ai-run-pane__sidebar-toggle")).toHaveAttribute("aria-expanded", "false")

  // The toggle opens it at the width it had before the drag closed it.
  await page.locator(".ai-run-pane__sidebar-toggle").click()
  await expect(page.locator(".ai-run-pane__sidebar")).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(60)

  // The width outlives the view: reopened, the pane comes back at 60px.
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await page.locator(".ai-run-pane .xterm").first().waitFor()
  await expect.poll(() => sidebarWidth(page)).toBe(60)
  expect(await page.evaluate((key) => window.app.loadLocalStorage(key), WIDTH_KEY)).toBe(60)
})

test("closed, the panels' left edge drags the sidebar open again; a double click resets it", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  await openPaneWithTerminal(page, home!, testInfo.outputPath("bin"))

  await page.locator(".ai-run-pane__sidebar-toggle").click()
  await expect(page.locator(".ai-run-pane__sidebar")).toBeHidden()

  const row = await box(page, ".ai-run-pane__layout")
  const y = Math.round((row.top + row.bottom) / 2)
  // The edge takes the pointer below the tab row, but ▾ and the toggle on the
  // row itself keep theirs.
  expect(await hitsSplitter(page, row.left + 3, y)).toBe(true)
  const collapse = await box(page, ".ai-run-pane__collapse")
  expect(await hitsSplitter(page, row.left + 3, Math.round((collapse.top + collapse.bottom) / 2))).toBe(false)

  await dragSplitterTo(page, 223, async () => !(await isClosed(page)) && (await sidebarWidth(page)) === 220)
  await expect(page.locator(".ai-run-pane__sidebar")).toBeVisible()

  // A double click on the splitter goes back to the default width.
  const open = await box(page, ".ai-run-pane__sidebar")
  await page.mouse.dblclick(open.right, y)
  await expect.poll(() => sidebarWidth(page)).toBe(180)
  expect(await page.evaluate((key) => window.app.loadLocalStorage(key), WIDTH_KEY)).toBeNull()
})
