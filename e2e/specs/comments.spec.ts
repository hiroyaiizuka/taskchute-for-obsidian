import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, rowState, taskRow, todayKey } from "../helpers/aiTask"

// #181: comments written while working — the day's comments behind a button
// at the bottom right of the task list (LEV-346), and a running task's
// comments under its row.

function readDayComments(vaultDir: string, dateKey: string): Array<{ text: string; instanceId?: string }> {
  const file = path.join(vaultDir, "TaskChute", "Log", `${dateKey.slice(0, 7)}-state.json`)
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    days?: Record<string, { comments?: Array<{ text: string; instanceId?: string; deletedAt?: number }> }>
  }
  return (parsed.days?.[dateKey]?.comments ?? []).filter((c) => c.deletedAt === undefined)
}

async function createTask(page: Page, title: string): Promise<string> {
  const today = await todayKey(page)
  const taskPath = `${TASK_FOLDER}/${title}.md`
  const content = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  await page.evaluate(
    async ([folder, file, data]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(file, data)
    },
    [TASK_FOLDER, taskPath, content] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as { metadataCache: { getCache(path: string): { frontmatter?: unknown } | null } }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, taskPath)
  return taskPath
}

/** Turns on the day's comments button (off by default) the way the settings toggle does. */
async function enableDayComments(page: Page) {
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.dayCommentsEnabled = true
    await plugin.saveSettings()
  }, "taskchute-plus")
}

const dayButton = (page: Page) => page.locator(".taskchute-day-comments-button")
const dayWindow = (page: Page) => page.locator(".taskchute-day-comments-window")
const dayInput = (page: Page) => dayWindow(page).locator(".taskchute-day-comments-window__input textarea")

test("the day's comments button is off by default and appears once turned on", async ({ obsidian }) => {
  const { page } = obsidian
  await openTaskChute(page)
  await expect(dayButton(page)).toBeHidden()
  await enableDayComments(page)
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await expect(dayButton(page)).toBeVisible()
  await expect(dayButton(page)).toHaveText("")
})

test("a comment on the day is kept in the day state, with no count on the button, and shown again after reopening", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await enableDayComments(page)
  await openTaskChute(page)
  const today = await todayKey(page)

  await dayButton(page).click()
  await expect(dayInput(page)).toBeFocused()
  await dayInput(page).fill("Finish the draft before lunch")
  await dayInput(page).press("Enter")

  await expect(dayWindow(page).locator(".taskchute-comment-text")).toHaveText(["Finish the draft before lunch"])
  await expect.poll(() => readDayComments(vaultDir, today).map((c) => c.text)).toEqual(["Finish the draft before lunch"])
  await expect(dayInput(page)).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(dayWindow(page)).toHaveCount(0)
  await expect(dayButton(page)).toHaveText("")

  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await dayButton(page).click()
  await expect(dayWindow(page).locator(".taskchute-comment-text")).toHaveText(["Finish the draft before lunch"])
})

test("the window floats over the bottom right of the list, stays open on a click outside, and closes from × and the button", async ({ obsidian }) => {
  const { page } = obsidian
  await createTask(page, "Write report")
  await enableDayComments(page)
  await openTaskChute(page)

  await dayButton(page).click()
  await expect(dayWindow(page)).toBeVisible()
  const placement = await page.evaluate(() => {
    const area = document.querySelector(".taskchute-list-area")!.getBoundingClientRect()
    const win = document.querySelector(".taskchute-day-comments-window")!.getBoundingClientRect()
    const button = document.querySelector(".taskchute-day-comments-button")!.getBoundingClientRect()
    return {
      inside: win.left >= area.left && win.right <= area.right && win.top >= area.top && win.bottom <= area.bottom,
      aboveButton: win.bottom <= button.top,
      rightAligned: Math.abs(area.right - win.right - (area.right - button.right)) <= 1,
    }
  })
  expect(placement).toEqual({ inside: true, aboveButton: true, rightAligned: true })
  await expect(dayWindow(page).locator(".taskchute-comment-composer__add")).toBeInViewport()

  // Reading the tasks while writing: a click on the list leaves the window open.
  await page.locator(".taskchute-view-root .task-list").click({ position: { x: 2, y: 2 } })
  await expect(dayWindow(page)).toBeVisible()

  await dayWindow(page).locator(".taskchute-day-comments-window__close").click()
  await expect(dayWindow(page)).toHaveCount(0)
  await dayButton(page).click()
  await expect(dayWindow(page)).toBeVisible()
  await dayButton(page).click()
  await expect(dayWindow(page)).toHaveCount(0)
  // The TaskChute view is still the one shown.
  await expect(page.locator(".taskchute-view-root")).toBeVisible()
})

test("a running task takes comments, and the completion modal lists them", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  const taskPath = await createTask(page, "Write report")
  await openTaskChute(page)
  const today = await todayKey(page)
  const row = taskRow(page, taskPath)
  await expect(row).toBeVisible()

  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("running")

  await row.locator(".comment-button").click()
  const popoverInput = page.locator(".taskchute-task-comments-popover textarea")
  await expect(popoverInput).toBeFocused()
  await popoverInput.fill("Outline done")
  await popoverInput.press("Enter")

  await expect(row.locator(".comment-button")).toHaveClass(/\bactive\b/)
  await expect(row.locator(".comment-button")).toHaveText("💬")
  await expect.poll(() => readDayComments(vaultDir, today)).toEqual([
    expect.objectContaining({ text: "Outline done", instanceId: expect.any(String) }),
  ])

  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("done")
  await expect(page.locator(".taskchute-task-comments-popover")).toHaveCount(0)

  await row.locator(".comment-button").click()
  const recap = page.locator(".taskchute-comment-recap")
  await expect(recap).toBeVisible()
  await expect(recap.locator(".taskchute-comment-text")).toHaveText(["Outline done"])
})

test("a task's comments come back after it is reset, the view reloads, and it is started again", async ({ obsidian }) => {
  const { page } = obsidian
  const taskPath = await createTask(page, "Write report")
  await openTaskChute(page)
  const row = () => taskRow(page, taskPath)

  await row().locator(".play-stop-button").click()
  await expect.poll(() => rowState(row())).toBe("running")
  await row().locator(".comment-button").click()
  await page.locator(".taskchute-task-comments-popover textarea").fill("Outline done")
  await page.locator(".taskchute-task-comments-popover textarea").press("Enter")
  await expect(row().locator(".comment-button")).toHaveClass(/\bactive\b/)

  // Back to not started, then a fresh load of the view.
  await row().locator(".settings-task-button").click()
  await page.locator(".task-settings-tooltip .tooltip-item", { hasText: "Reset to not started" }).click()
  await expect.poll(() => rowState(row())).toBe("idle")
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)

  await row().locator(".play-stop-button").click()
  await expect.poll(() => rowState(row())).toBe("running")
  await expect(row().locator(".comment-button")).toHaveClass(/\bactive\b/)
})

// A running row's 💬 waits for the pointer on its row until the task has a
// comment, like a done task's empty one (LEV-366); then it stays shown. Shown,
// it lies flat: the filled button comes up only under the pointer.
test("a running task's comment button shows on hover until its first comment, and lies flat", async ({ obsidian }) => {
  const { page } = obsidian
  const taskPath = await createTask(page, "Write report")
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("running")
  const button = row.locator(".comment-button")
  const look = () =>
    button.evaluate((el) => {
      const style = getComputedStyle(el)
      return { opacity: style.opacity, shadow: style.boxShadow, background: style.backgroundColor }
    })
  expect(await page.evaluate(() => window.matchMedia("(hover: hover)").matches)).toBe(true)

  await page.locator(".top-bar-container").hover()
  await expect.poll(async () => (await look()).opacity).toBe("0")
  await row.locator(".task-name").hover()
  await expect.poll(async () => (await look()).opacity).toBe("0.6")
  await button.hover()
  await expect.poll(async () => (await look()).opacity).toBe("1")
  expect((await look()).background).not.toBe("rgba(0, 0, 0, 0)")

  await button.click()
  const popoverInput = page.locator(".taskchute-task-comments-popover textarea")
  await popoverInput.fill("Outline done")
  await popoverInput.press("Enter")
  await expect(button).toHaveClass(/\bactive\b/)
  await button.click()
  await expect(page.locator(".taskchute-task-comments-popover")).toHaveCount(0)

  await page.locator(".top-bar-container").hover()
  await expect.poll(look).toEqual({ opacity: "0.6", shadow: "none", background: "rgba(0, 0, 0, 0)" })
})

// The 💬 opens a popover under itself, laid out like the day's window: no row
// moves, the comments pile up oldest first above an input that keeps its
// size when focused, and Esc closes it.
test("a running task's 💬 opens a popover under it that moves no row", async ({ obsidian }) => {
  const { page } = obsidian
  const taskPath = await createTask(page, "Write report")
  await createTask(page, "Answer mail")
  await createTask(page, "Weekly review")
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("running")
  const rowTops = () =>
    page.locator(".taskchute-view-root .task-item").evaluateAll((rows) => rows.map((el) => Math.round(el.getBoundingClientRect().top)))
  const before = await rowTops()

  const button = row.locator(".comment-button")
  await button.click()
  const popover = page.locator(".taskchute-task-comments-popover")
  const input = popover.locator("textarea")
  await expect(input).toBeFocused()
  expect(await rowTops()).toEqual(before)
  // Under the 💬, its right edge on the 💬's (once the opening animation is over).
  await expect
    .poll(async () => {
      const [b, p] = await Promise.all([button.boundingBox(), popover.boundingBox()])
      return Math.round(b!.x + b!.width - (p!.x + p!.width))
    })
    .toBe(0)
  expect((await popover.boundingBox())!.y).toBeGreaterThan((await button.boundingBox())!.y + (await button.boundingBox())!.height)

  const inputHeight = () => input.evaluate((el) => (el as HTMLElement).offsetHeight)
  const height = await inputHeight()
  for (const text of ["Outline done", "Asked for review"]) {
    await input.fill(text)
    await input.press("Enter")
  }
  await expect(popover.locator(".taskchute-comment-text")).toHaveText(["Outline done", "Asked for review"])
  await expect(input).toBeFocused()
  expect(await inputHeight()).toBe(height)
  expect(await rowTops()).toEqual(before)

  await input.press("Escape")
  await expect(popover).toHaveCount(0)
})

// The popover's list has one size from the start, three one-line comments:
// adding never moves its edge or its input, the fourth and older are a scroll
// away, and each add keeps the newest in view.
test("a running task's popover keeps its size: three comments fit, the fourth scrolls", async ({ obsidian }) => {
  const { page } = obsidian
  const taskPath = await createTask(page, "Write report")
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("running")
  await row.locator(".comment-button").click()
  const popover = page.locator(".taskchute-task-comments-popover")
  const input = popover.locator("textarea")
  await expect(input).toBeFocused()
  const box = () =>
    popover.evaluate((el) => {
      const body = el.querySelector<HTMLElement>(".taskchute-day-comments-window__body")!
      return {
        height: (el as HTMLElement).offsetHeight,
        scrolls: body.scrollHeight > body.clientHeight,
        atEnd: Math.abs(body.scrollTop + body.clientHeight - body.scrollHeight) < 2,
      }
    })
  const empty = await box()
  expect(empty.scrolls).toBe(false)

  for (let i = 1; i <= 4; i += 1) {
    await input.fill(`Note ${i}`)
    await input.press("Enter")
    await expect(popover.locator(".taskchute-comment-text")).toHaveCount(i)
    await expect.poll(box).toEqual({ height: empty.height, scrolls: i > 3, atEnd: true })
  }
  await expect(input).toBeFocused()
})

// LEV-366: with a mouse, a done task's empty 💬 shows only while the pointer is
// on its row; one with a comment stays shown, and a not-started task's stays hidden.
test("a done task's empty comment button shows only while its row is hovered", async ({ obsidian }) => {
  const { page } = obsidian
  const withComment = await createTask(page, "Write report")
  const withoutComment = await createTask(page, "Answer mail")
  const notStarted = await createTask(page, "Weekly review")
  await openTaskChute(page)
  const button = (taskPath: string) => taskRow(page, taskPath).locator(".comment-button")
  const shown = (taskPath: string) =>
    button(taskPath).evaluate((el) => {
      const style = getComputedStyle(el)
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
    })
  expect(await page.evaluate(() => window.matchMedia("(hover: hover)").matches)).toBe(true)

  for (const taskPath of [withComment, withoutComment]) {
    await taskRow(page, taskPath).locator(".play-stop-button").click()
    await expect.poll(() => rowState(taskRow(page, taskPath))).toBe("running")
    await taskRow(page, taskPath).locator(".play-stop-button").click()
    await expect.poll(() => rowState(taskRow(page, taskPath))).toBe("done")
  }
  await button(withComment).click()
  const modal = page.locator(".taskchute-comment-modal")
  await modal.locator("textarea").fill("Outline done")
  await modal.locator(".modal-button-container button.create").click()
  await expect(button(withComment)).toHaveClass(/active/)
  await expect(button(withoutComment)).toHaveClass(/no-comment/)

  await page.locator(".top-bar-container").hover()
  await expect.poll(() => shown(withComment)).toBe(true)
  await expect.poll(() => shown(withoutComment)).toBe(false)
  await expect.poll(() => shown(notStarted)).toBe(false)

  await taskRow(page, withoutComment).locator(".task-name").hover()
  await expect.poll(() => shown(withoutComment)).toBe(true)
  await button(withoutComment).click()
  await expect(modal.locator("textarea")).toHaveValue("")
  await modal.locator(".modal-button-container button.cancel").click()

  await taskRow(page, notStarted).locator(".task-name").hover()
  await expect.poll(() => shown(notStarted)).toBe(false)
})

// LEV-366, on a phone: the empty 💬 is not seen either -- there is no hover to
// bring it up -- but a tap where it sits still opens the comment.
test("on a phone a done task's empty comment button is unseen but still opens the comment", async ({ obsidian }) => {
  const { page } = obsidian
  // Phone, not tablet: Obsidian decides by the window's width, so size it first.
  await page.evaluate(() => {
    const host = window as unknown as {
      electron?: { remote?: { getCurrentWindow?: () => { setContentSize?: (w: number, h: number) => void } } }
    }
    host.electron?.remote?.getCurrentWindow?.()?.setContentSize?.(390, 844)
  })
  await page.evaluate(() => (window.app as unknown as { emulateMobile(on: boolean): void }).emulateMobile(true))
  await page.waitForFunction(() => document.body.classList.contains("is-phone"), undefined, { timeout: 15_000 })
  // Turning the emulation on reloads the plugins.
  await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, { timeout: 15_000 })
  // Obsidian's emulation leaves `(hover: none)` false; touch emulation is what turns it on.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  expect(await page.evaluate(() => window.matchMedia("(hover: none)").matches)).toBe(true)

  const taskPath = await createTask(page, "Answer mail")
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("running")
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("done")
  const button = row.locator(".comment-button")
  await expect(button).toHaveClass(/no-comment/)

  await row.locator(".task-name").hover()
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("0")
  await button.click()
  await expect(page.locator(".taskchute-comment-modal textarea")).toHaveValue("")
})
