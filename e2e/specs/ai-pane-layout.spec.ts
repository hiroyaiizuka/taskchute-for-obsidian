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

/** A box in CSS pixels, rounded. */
async function box(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }
  })
}

/** An element's left and right edges, its four border widths and its corners. */
async function frame(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(" "),
      radius: s.borderRadius,
    }
  })
}

/** The pane has the task list's frame: the same edges, line and corners. */
async function expectFramedLikeTaskList(page: Page) {
  const pane = await frame(page, ".ai-run-pane")
  expect(pane.border).toBe("1px 1px 1px 1px")
  expect(pane).toEqual(await frame(page, ".taskchute-view-root .task-list"))
}

/** A row's bottom line color, to tell a drawn line from a transparent one. */
async function bottomLineColor(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).borderBottomColor)
}

// No title row: the pane's controls lie over the two ends of the terminal tab
// row. The pane is framed like the task list above it -- the same edges, line
// and corners -- and the sidebar hides outright from a toggle on that row.
// Collapsed, the tab row stays, closed by the frame's line alone, and the
// terminal goes.
test("the pane's controls share the tab row, the pane is framed like the task list, and the sidebar hides outright", async ({ obsidian, home }, testInfo) => {
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

  // The name is there for screen readers but takes no room on screen.
  await expect(page.locator(".ai-run-pane__title")).toHaveText("AI runs")
  expect(
    await page.locator(".ai-run-pane__title").evaluate((el) => Math.round(el.getBoundingClientRect().width)),
  ).toBeLessThanOrEqual(1)

  // One row: the controls sit on the tab row, which is the pane's first.
  const pane = await box(page, ".ai-run-pane")
  const tabRow = await box(page, ".ai-run-pane__panel .ai-run-pane__tabstrip")
  expect((await box(page, ".ai-run-pane__header")).top).toBe(tabRow.top)
  expect(tabRow.top - pane.top).toBeLessThanOrEqual(1)

  // The task list's frame, at half height and full screen (⤢) alike.
  await expectFramedLikeTaskList(page)
  await page.locator(".ai-run-pane__expand").click()
  await expect.poll(async () => (await layout(page)).dateRow).toBe(0)
  await expectFramedLikeTaskList(page)
  await page.locator(".ai-run-pane__expand").click()
  await expect.poll(async () => (await layout(page)).dateRow).toBeGreaterThan(0)

  // The sidebar's toggle sits on the sidebar's edge, past files and history.
  await expect(page.locator(".ai-run-pane__sidebar")).toBeVisible()
  const sidebar = await box(page, ".ai-run-pane__sidebar")
  const toggleOpen = await box(page, ".ai-run-pane__sidebar-toggle")
  expect(sidebar.right - toggleOpen.right).toBeLessThanOrEqual(8)
  expect(toggleOpen.left).toBeGreaterThan((await box(page, ".ai-run-pane__sidebar-history")).right)

  // The sidebar hides outright, and the terminal takes its width.
  const terminalWidth = () =>
    page.locator(".ai-run-pane .xterm-screen").first().evaluate((el) => Math.round(el.getBoundingClientRect().width))
  const withSidebar = await terminalWidth()
  await page.locator(".ai-run-pane__sidebar-toggle").click()
  await expect(page.locator(".ai-run-pane__sidebar")).toBeHidden()
  await expect.poll(terminalWidth).toBeGreaterThan(withSidebar)

  // Neither end's controls cover the row's own: ▾, then the toggle, then the
  // tabs; the split button ends before ⤢.
  const collapse = await box(page, ".ai-run-pane__collapse")
  const toggleClosed = await box(page, ".ai-run-pane__sidebar-toggle")
  expect(toggleClosed.left).toBeGreaterThanOrEqual(collapse.right)
  expect((await box(page, ".ai-run-pane__panel .ai-run-pane__tabs")).left).toBeGreaterThanOrEqual(toggleClosed.right)
  // Windows terminals run without the broker, so they have no split button.
  if (process.platform !== "win32") {
    expect((await box(page, ".ai-run-pane__split")).right).toBeLessThanOrEqual(
      (await box(page, ".ai-run-pane__expand")).left,
    )
  }

  // Collapsed, with the sidebar back: the tab row and the sidebar's toolbar
  // stay, still framed like the task list, and the terminal goes. The frame's
  // bottom line closes the row; the rows' own bottom lines would be a second
  // one on it.
  await page.locator(".ai-run-pane__sidebar-toggle").click()
  await expect(page.locator(".ai-run-pane__sidebar")).toBeVisible()
  await page.locator(".ai-run-pane__collapse").click()
  await expect(page.locator(".ai-run-pane__panel .ai-run-pane__tabstrip").first()).toBeVisible()
  await expect(page.locator(".ai-run-pane__sidebar-toolbar")).toBeVisible()
  await expect(page.locator(".ai-run-pane .xterm").first()).toBeHidden()
  await expectFramedLikeTaskList(page)
  expect(await bottomLineColor(page, ".ai-run-pane__panel .ai-run-pane__tabstrip")).toBe("rgba(0, 0, 0, 0)")
  expect(await bottomLineColor(page, ".ai-run-pane__sidebar-toolbar")).toBe("rgba(0, 0, 0, 0)")
})
