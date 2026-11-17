import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, rowState, taskRow, todayKey } from "../helpers/aiTask"
import { createNotes } from "../recording/helpers"

// Comments for reading the day back, for the 10X course (2026-11):
// - LEV-415: a command that goes straight to a running task's comment.
// - LEV-413: a comment can be rewritten in place.
// - LEV-412: a task's comments from while it ran, under its row (a setting)
//   and in the execution log, with the day's own comments.

interface StoredComment {
  id: string
  text: string
  instanceId?: string
  deletedAt?: number
}

function readComments(vaultDir: string, dateKey: string): StoredComment[] {
  const file = path.join(vaultDir, "TaskChute", "Log", `${dateKey.slice(0, 7)}-state.json`)
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { days?: Record<string, { comments?: StoredComment[] }> }
  return (parsed.days?.[dateKey]?.comments ?? []).filter((c) => c.deletedAt === undefined)
}

async function setSetting(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(
    async ([id, k, v]) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
      plugin.settings[k] = v
      await plugin.saveSettings()
    },
    [PLUGIN_ID, key, value] as const,
  )
}

async function createTasks(page: Page, titles: string[]): Promise<string[]> {
  const today = await todayKey(page)
  const body = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  const paths = titles.map((title) => `${TASK_FOLDER}/${title}.md`)
  await createNotes(page, Object.fromEntries(paths.map((p) => [p, body])))
  return paths
}

async function start(page: Page, taskPath: string): Promise<void> {
  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("running")
}

async function stop(page: Page, taskPath: string): Promise<void> {
  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("done")
}

async function runCommand(page: Page, id: string): Promise<void> {
  await page.evaluate((commandId) => {
    const app = window.app as unknown as { commands: { executeCommandById(id: string): boolean } }
    app.commands.executeCommandById(commandId)
  }, `${PLUGIN_ID}:${id}`)
}

/** A note on screen in place of the task list, as when the hotkey is pressed while writing. */
async function showANote(page: Page): Promise<void> {
  // createNotes waits for frontmatter, so the note has some.
  await createNotes(page, { "Notes/Meeting.md": "---\nkind: meeting\n---\n# Meeting\n" })
  await page.evaluate(async () => {
    const vault = window.app.vault as unknown as { getAbstractFileByPath(path: string): unknown }
    const file = vault.getAbstractFileByPath("Notes/Meeting.md")
    const workspace = window.app.workspace as unknown as {
      getLeaf(newLeaf: boolean): { openFile(file: unknown): Promise<void> }
    }
    await workspace.getLeaf(true).openFile(file)
  })
  await expect(page.locator(".workspace-leaf.mod-active .view-header-title", { hasText: "Meeting" })).toBeVisible()
}

const entryModal = (page: Page) => page.locator(".taskchute-comment-entry-modal")
const suggest = (page: Page) => page.locator(".taskchute-running-task-suggest")

test.describe("LEV-415: Leave a comment on the running task", () => {
  test("is in the command palette with no hotkey, and says so when nothing is running", async ({ obsidian }) => {
    const { page } = obsidian
    await openTaskChute(page)
    const command = await page.evaluate((id) => {
      const app = window.app as unknown as {
        commands: { commands: Record<string, { name: string; hotkeys?: unknown[] }> }
      }
      const found = app.commands.commands[`${id}:leave-running-comment`]
      return found ? { name: found.name, hotkeys: found.hotkeys ?? [] } : null
    }, PLUGIN_ID)
    expect(command).toEqual({ name: "TaskChute Plus: Leave a comment on the running task", hotkeys: [] })

    await runCommand(page, "leave-running-comment")
    await expect(page.locator(".notice", { hasText: "No task is running." })).toBeVisible()
    await expect(entryModal(page)).toHaveCount(0)
  })

  test("with one task running, opens its comment over a note, and Enter keeps it", async ({ obsidian }) => {
    const { page, vaultDir } = obsidian
    const [taskPath] = await createTasks(page, ["Write report"])
    await openTaskChute(page)
    const today = await todayKey(page)
    await start(page, taskPath)
    await showANote(page)

    await runCommand(page, "leave-running-comment")
    await expect(suggest(page)).toHaveCount(0)
    await expect(entryModal(page).locator(".modal-title")).toHaveText('Add a comment to "Write report"')
    const input = entryModal(page).locator("textarea")
    await expect(input).toBeFocused()
    await input.fill("Outline done")
    await input.press("Enter")

    await expect(entryModal(page)).toHaveCount(0)
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text)).toEqual(["Outline done"])
    // The note stays on screen: the comment did not pull the task list forward.
    await expect(page.locator(".workspace-leaf.mod-active .view-header-title", { hasText: "Meeting" })).toBeVisible()
  })

  test("with several running, lists them to pick from, then opens the one picked", async ({ obsidian }) => {
    const { page, vaultDir } = obsidian
    const paths = await createTasks(page, ["Write report", "Reply to mail", "Walk"])
    await openTaskChute(page)
    const today = await todayKey(page)
    for (const taskPath of paths) await start(page, taskPath)

    await runCommand(page, "leave-running-comment")
    await expect(suggest(page)).toBeVisible()
    await expect(suggest(page).locator(".suggestion-item")).toHaveCount(3)
    await suggest(page).locator(".prompt-input").fill("mail")
    await expect(suggest(page).locator(".suggestion-item")).toHaveText(["Reply to mail"])
    await page.keyboard.press("Enter")

    await expect(entryModal(page).locator(".modal-title")).toHaveText('Add a comment to "Reply to mail"')
    await entryModal(page).locator("textarea").fill("Two left")
    await entryModal(page).locator("textarea").press("Enter")
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text)).toEqual(["Two left"])
    const instanceId = await taskRow(page, paths[1]).getAttribute("data-instance-id")
    expect(readComments(vaultDir, today)[0].instanceId).toBe(instanceId)
  })
})

test.describe("LEV-413: rewriting a comment", () => {
  test("a comment for the day is rewritten in place and kept, with its time", async ({ obsidian }) => {
    const { page, vaultDir } = obsidian
    await setSetting(page, "dayCommentsEnabled", true)
    await openTaskChute(page)
    const today = await todayKey(page)
    const win = page.locator(".taskchute-day-comments-window")

    await page.locator(".taskchute-day-comments-button").click()
    await win.locator(".taskchute-day-comments-window__input textarea").fill("Thanks to Mr Fujima")
    await win.locator(".taskchute-day-comments-window__input textarea").press("Enter")
    await expect(win.locator(".taskchute-comment-text")).toHaveText(["Thanks to Mr Fujima"])
    const [before] = readComments(vaultDir, today)
    const time = await win.locator(".taskchute-comment-list time").textContent()

    const item = win.locator(".taskchute-comment-list > li").first()
    await item.hover()
    await item.locator(".taskchute-comment-edit").click()
    const editor = win.locator("li.is-editing textarea")
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue("Thanks to Mr Fujima")
    await editor.fill("Thanks to Mr Fujima, for the meeting")
    await editor.press("Enter")

    await expect(win.locator("li.is-editing")).toHaveCount(0)
    await expect(win.locator(".taskchute-comment-text")).toHaveText(["Thanks to Mr Fujima, for the meeting"])
    await expect(win.locator(".taskchute-comment-list time")).toHaveText(time ?? "")
    await expect.poll(() => readComments(vaultDir, today)).toEqual([
      expect.objectContaining({ id: before.id, text: "Thanks to Mr Fujima, for the meeting" }),
    ])
    // The window is still open; Esc on an edit only drops the edit.
    await item.hover()
    await item.locator(".taskchute-comment-edit").click()
    await win.locator("li.is-editing textarea").fill("thrown away")
    await win.locator("li.is-editing textarea").press("Escape")
    await expect(win).toBeVisible()
    await expect(win.locator(".taskchute-comment-text")).toHaveText(["Thanks to Mr Fujima, for the meeting"])
  })
})

test.describe("LEV-412: reading the comments back", () => {
  test("with the setting on, a task's comments from while it ran sit under its row", async ({ obsidian }) => {
    const { page } = obsidian
    const [taskPath] = await createTasks(page, ["Write report"])
    await openTaskChute(page)
    await start(page, taskPath)
    for (const text of ["Opened the last minutes", "A template will do"]) {
      await runCommand(page, "leave-running-comment")
      await entryModal(page).locator("textarea").fill(text)
      await entryModal(page).locator("textarea").press("Enter")
      await expect(entryModal(page)).toHaveCount(0)
    }
    await stop(page, taskPath)
    const instanceId = await taskRow(page, taskPath).getAttribute("data-instance-id")
    const under = page.locator(`.taskchute-row-comments[data-instance-id="${instanceId}"]`)

    // Off by default.
    await expect(under).toHaveCount(0)
    await setSetting(page, "rowCommentsEnabled", true)
    await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
    await openTaskChute(page)

    await expect(under.locator(".taskchute-comment-text")).toHaveText(["Opened the last minutes", "A template will do"])
    await expect(under.locator("time")).toHaveCount(2)
    // Right under its own row, lined up with the task name.
    const placement = await page.evaluate((id) => {
      const row = document.querySelector(`.task-item[data-instance-id="${id}"]`)!
      const box = document.querySelector(`.taskchute-row-comments[data-instance-id="${id}"]`)!
      const name = row.querySelector(".task-name")!.getBoundingClientRect()
      const text = box.querySelector(".taskchute-comment-list")!.getBoundingClientRect()
      return { follows: row.nextElementSibling === box, nameLeft: Math.round(name.left), listLeft: Math.round(text.left) }
    }, instanceId)
    expect(placement.follows).toBe(true)
    expect(Math.abs(placement.nameLeft - placement.listLeft)).toBeLessThanOrEqual(24)
  })

  test("the execution log shows them under the task's comment, and the day's own under the table", async ({ obsidian }) => {
    const { page } = obsidian
    await setSetting(page, "dayCommentsEnabled", true)
    const [taskPath] = await createTasks(page, ["Write report"])
    await openTaskChute(page)
    await start(page, taskPath)
    await runCommand(page, "leave-running-comment")
    await entryModal(page).locator("textarea").fill("Halfway")
    await entryModal(page).locator("textarea").press("Enter")
    await expect(entryModal(page)).toHaveCount(0)
    await stop(page, taskPath)

    const win = page.locator(".taskchute-day-comments-window")
    await page.locator(".taskchute-day-comments-button").click()
    await win.locator(".taskchute-day-comments-window__input textarea").fill("A good day")
    await win.locator(".taskchute-day-comments-window__input textarea").press("Enter")
    await expect(win.locator(".taskchute-comment-text")).toHaveText(["A good day"])
    await page.keyboard.press("Escape")

    await page.locator(".taskchute-view-root .drawer-toggle").click()
    await page.locator('.navigation-nav-item[data-section="log"]').click()
    const log = page.locator(".taskchute-log-modal")
    const row = log.locator(".heatmap-detail-table tbody tr", { hasText: "Write report" })
    await expect(row.locator(".heatmap-detail-comment-list.is-running .heatmap-detail-comment-text")).toHaveText(["Halfway"])
    // The execution-time column says when; the row does not repeat the time.
    await expect(row.locator(".heatmap-detail-comment-list time")).toHaveCount(0)
    const day = log.locator(".heatmap-detail-day-comments")
    await expect(day.locator(".heatmap-detail-day-comments__title")).toContainText("Today's comments")
    await expect(day.locator(".heatmap-detail-comment-text")).toHaveText(["A good day"])
    await expect(day.locator("time")).toHaveCount(1)
  })

  test("the log table keeps headings on one line and five ratings in a fixed width", async ({ obsidian }) => {
    const { page } = obsidian
    const [taskPath] = await createTasks(page, ["A task whose name is long enough to need a second line in the log"])
    await openTaskChute(page)
    await start(page, taskPath)
    await stop(page, taskPath)
    await page.locator(".taskchute-view-root .drawer-toggle").click()
    await page.locator('.navigation-nav-item[data-section="log"]').click()
    const table = page.locator(".taskchute-log-modal .heatmap-detail-table")
    await expect(table.locator("tbody tr")).toHaveCount(1)
    // A narrow table, and the most a rating can hold. The ratings are written in
    // directly: this checks the layout, not how a rating is recorded.
    const layout = await table.evaluate((t) => {
      ;(t.closest(".heatmap-detail-section") as HTMLElement).style.width = "560px"
      const focus = t.querySelector("td.heatmap-col-focus")!
      const energy = t.querySelector("td.heatmap-col-energy")!
      const before = [focus.clientWidth, energy.clientWidth]
      focus.textContent = "⭐️".repeat(5)
      energy.textContent = "⚡️".repeat(5)
      // A cell is as tall as its row; measure the text itself.
      const lines = (el: Element) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const height = range.getBoundingClientRect().height
        return Math.round(height / parseFloat(getComputedStyle(el).lineHeight))
      }
      return {
        headings: Array.from(t.querySelectorAll("th"), lines),
        time: lines(t.querySelector("td.heatmap-detail-time")!),
        name: lines(t.querySelector("td.heatmap-detail-name")!),
        widths: { before, after: [focus.clientWidth, energy.clientWidth] },
        overflow: [focus, energy].map((el) => el.scrollWidth > el.clientWidth),
      }
    })
    expect(layout.headings).toEqual([1, 1, 1, 1, 1])
    expect(layout.time).toBe(1)
    expect(layout.name).toBeGreaterThan(1)
    expect(layout.widths.after).toEqual(layout.widths.before)
    expect(layout.overflow).toEqual([false, false])
  })
})

// Iizuka's review on device (2026-11-17): a running task's comments are
// rewritten and deleted from the row like the day's, and deleting anywhere
// asks first.
test.describe("Review 2026-11-17: editing a running task's comments, and asking before deleting", () => {
  const confirmDialog = (page: Page) => page.locator(".modal-container .taskchute-confirm-modal")

  async function taskWithComments(page: Page, texts: string[]): Promise<{ taskPath: string; instanceId: string }> {
    const [taskPath] = await createTasks(page, ["Write report"])
    await openTaskChute(page)
    await start(page, taskPath)
    for (const text of texts) {
      await runCommand(page, "leave-running-comment")
      await entryModal(page).locator("textarea").fill(text)
      await entryModal(page).locator("textarea").press("Enter")
      await expect(entryModal(page)).toHaveCount(0)
    }
    const instanceId = (await taskRow(page, taskPath).getAttribute("data-instance-id")) ?? ""
    return { taskPath, instanceId }
  }

  test("the comments under a row show the pencil and × on hover, and are rewritten and deleted there", async ({ obsidian }) => {
    const { page, vaultDir } = obsidian
    await setSetting(page, "rowCommentsEnabled", true)
    const today = await todayKey(page)
    const { taskPath, instanceId } = await taskWithComments(page, ["Opened the minutse", "Not needed"])
    await stop(page, taskPath)
    const under = page.locator(`.taskchute-row-comments[data-instance-id="${instanceId}"]`)
    await expect(under.locator(".taskchute-comment-text")).toHaveText(["Opened the minutse", "Not needed"])

    const first = under.locator(".taskchute-comment-list > li").first()
    await expect(first.locator(".taskchute-comment-edit")).toHaveCSS("opacity", "0")
    await first.hover()
    await expect(first.locator(".taskchute-comment-edit")).toHaveCSS("opacity", "1")
    await expect(first.locator(".taskchute-comment-delete")).toHaveCSS("opacity", "1")

    await first.locator(".taskchute-comment-edit").click()
    const input = under.locator("li.is-editing textarea")
    await expect(input).toBeFocused()
    await input.fill("Opened the minutes")
    await input.press("Enter")
    await expect(under.locator(".taskchute-comment-text")).toHaveText(["Opened the minutes", "Not needed"])
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text).sort()).toEqual(["Not needed", "Opened the minutes"])

    const second = under.locator(".taskchute-comment-list > li").nth(1)
    await second.hover()
    await second.locator(".taskchute-comment-delete").click()
    await expect(confirmDialog(page)).toContainText("Delete this comment?")
    await expect(confirmDialog(page)).toContainText("Not needed")
    await confirmDialog(page).locator(".mod-warning").click()
    await expect(under.locator(".taskchute-comment-text")).toHaveText(["Opened the minutes"])
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text)).toEqual(["Opened the minutes"])
  })

  test("deleting from the day's window and a task's popover asks first; cancel or Esc keeps the comment", async ({ obsidian }) => {
    const { page, vaultDir } = obsidian
    await setSetting(page, "dayCommentsEnabled", true)
    const today = await todayKey(page)
    const { taskPath } = await taskWithComments(page, ["On the task"])

    const win = page.locator(".taskchute-day-comments-window")
    await page.locator(".taskchute-day-comments-button").click()
    await win.locator(".taskchute-day-comments-window__input textarea").fill("On the day")
    await win.locator(".taskchute-day-comments-window__input textarea").press("Enter")
    await expect(win.locator(".taskchute-comment-text")).toHaveText(["On the day"])

    await win.locator(".taskchute-comment-list > li").hover()
    await win.locator(".taskchute-comment-delete").click()
    await expect(confirmDialog(page)).toBeVisible()
    // The cancel button has focus, so Enter by reflex does not delete.
    await expect(confirmDialog(page).locator("button:not(.mod-warning)")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(confirmDialog(page)).toHaveCount(0)
    await expect(win).toBeVisible()
    await expect(win.locator(".taskchute-comment-text")).toHaveText(["On the day"])

    await win.locator(".taskchute-comment-list > li").hover()
    await win.locator(".taskchute-comment-delete").click()
    await confirmDialog(page).locator(".mod-warning").click()
    await expect(win.locator(".taskchute-comment-text")).toHaveCount(0)
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text)).toEqual(["On the task"])
    await win.locator(".taskchute-day-comments-window__close").click()

    const row = taskRow(page, taskPath)
    await row.locator(".comment-button").click()
    const popover = page.locator(".taskchute-task-comments-popover")
    await popover.locator(".taskchute-comment-list > li").hover()
    await popover.locator(".taskchute-comment-delete").click()
    await confirmDialog(page).locator("button:not(.mod-warning)").click()
    await expect(popover).toBeVisible()
    await expect(popover.locator(".taskchute-comment-text")).toHaveText(["On the task"])
    await popover.locator(".taskchute-comment-list > li").hover()
    await popover.locator(".taskchute-comment-delete").click()
    await confirmDialog(page).locator(".mod-warning").click()
    await expect(popover.locator(".taskchute-comment-text")).toHaveCount(0)
    await expect.poll(() => readComments(vaultDir, today)).toEqual([])
  })

  test("the completion dialog rewrites its comments in place, Esc there leaving the dialog open, and asks before deleting", async ({ obsidian }) => {
    const { page, vaultDir } = obsidian
    const today = await todayKey(page)
    const { taskPath } = await taskWithComments(page, ["Outline dnoe", "Asked for review"])
    await stop(page, taskPath)
    await taskRow(page, taskPath).locator(".comment-button").click()
    const recap = page.locator(".taskchute-comment-recap")
    await expect(recap.locator(".taskchute-comment-text")).toHaveCount(2)
    const typo = recap.locator(".taskchute-comment-list > li", { hasText: "Outline dnoe" })
    await typo.hover()
    await typo.locator(".taskchute-comment-edit").click()
    const input = recap.locator("li.is-editing textarea")
    await expect(input).toBeFocused()
    await input.fill("thrown away")
    await input.press("Escape")
    await expect(recap).toBeVisible()
    await expect(recap.locator("li.is-editing")).toHaveCount(0)
    await expect(recap.locator(".taskchute-comment-text", { hasText: "Outline dnoe" })).toHaveCount(1)

    await typo.hover()
    await typo.locator(".taskchute-comment-edit").click()
    await input.fill("Outline done")
    await input.press("Enter")
    await expect(recap.locator(".taskchute-comment-text", { hasText: "Outline done" })).toHaveCount(1)
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text).sort()).toEqual(["Asked for review", "Outline done"])

    const other = recap.locator(".taskchute-comment-list > li", { hasText: "Asked for review" })
    await other.hover()
    await other.locator(".taskchute-comment-delete").click()
    await expect(confirmDialog(page)).toContainText("Asked for review")
    await confirmDialog(page).locator(".mod-warning").click()
    await expect(recap.locator(".taskchute-comment-text")).toHaveText(["Outline done"])
    await expect.poll(() => readComments(vaultDir, today).map((c) => c.text)).toEqual(["Outline done"])
  })
})
