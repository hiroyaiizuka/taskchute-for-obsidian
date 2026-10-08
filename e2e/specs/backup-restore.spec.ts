import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { TASK_FOLDER, openTaskChute, todayKey } from "../helpers/aiTask"

// A backup is a set: the execution log and the day state taken at one moment
// (`<stamp>.json` + `<stamp>.state.json`). Restoring one puts both back, so the
// day's comments and today-only deletions come back as they were.
//
// With the default backup interval, the month's first day-state write creates
// `YYYY-MM-state.json` and the second backs up the state as it was just before
// it. The day state and the execution log share that interval, so later
// writes of either within it make no new set.

const logDir = (vaultDir: string) => path.join(vaultDir, "TaskChute", "Log")

function backupFiles(vaultDir: string, monthKey: string): string[] {
  const dir = path.join(logDir(vaultDir), "backups", monthKey)
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

function readDayComments(vaultDir: string, dateKey: string): string[] {
  const file = path.join(logDir(vaultDir), `${dateKey.slice(0, 7)}-state.json`)
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    days?: Record<string, { comments?: Array<{ text: string; deletedAt?: number }> }>
  }
  return (parsed.days?.[dateKey]?.comments ?? []).filter((c) => c.deletedAt === undefined).map((c) => c.text)
}

async function enableDayComments(page: Page) {
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.dayCommentsEnabled = true
    await plugin.saveSettings()
  }, "taskchute-plus")
}

async function addDayComment(page: Page, text: string) {
  const input = page.locator(".taskchute-day-comments textarea")
  await input.click()
  await input.fill(text)
  await input.press("Enter")
  await expect(page.locator(".taskchute-day-comments .taskchute-comment-text", { hasText: text })).toBeVisible()
}

const dayCommentTexts = (page: Page) => page.locator(".taskchute-day-comments .taskchute-comment-text")
const rowsOf = (page: Page, taskPath: string) =>
  page.locator(`.taskchute-view-root .task-item[data-task-path="${taskPath}"]`)

async function createDailyRoutine(page: Page, title: string): Promise<string> {
  const today = await todayKey(page)
  const taskPath = `${TASK_FOLDER}/${title}.md`
  const content = [
    "---",
    "tags:",
    "  - task",
    "isRoutine: true",
    "routine_type: daily",
    "routine_interval: 1",
    "routine_enabled: true",
    `routine_start: "${today}"`,
    "---",
    "",
  ].join("\n")
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

async function deleteForToday(page: Page, taskPath: string) {
  await rowsOf(page, taskPath).first().locator(".settings-task-button").click()
  await page.locator(".task-settings-tooltip .tooltip-item", { hasText: "Delete task" }).click()
  await page.locator(".modal-container .mod-warning").click()
  await expect(rowsOf(page, taskPath)).toHaveCount(0)
}

/** Adds the task again from the add-task modal: pick the suggestion, keep "Reuse". */
async function reuseFromAddTask(page: Page, title: string) {
  await page.locator(".taskchute-view-root .add-task-button").click()
  const name = page.locator(".modal-container input").first()
  await name.click()
  await name.pressSequentially(title.slice(0, -3), { delay: 30 })
  await page.locator(".suggestion-item", { hasText: title }).first().click()
  await page.locator(".modal-container").getByRole("button", { name: "Save" }).click()
  await expect(page.locator(".modal-container")).toHaveCount(0)
}

/** Log → 🔄 Restore data → the newest backup → Restore this version → Restore. */
async function restoreNewestBackup(page: Page, options: { entries?: "one" | "many" } = {}) {
  await page.locator(".taskchute-view-root .drawer-toggle").click()
  await page.locator('.navigation-nav-item[data-section="log"]').click()
  await page.locator(".taskchute-log-modal .restore-button").click()
  const entries = page.locator(".backup-entry")
  if (options.entries === "many") await expect.poll(() => entries.count()).toBeGreaterThan(1)
  else await expect(entries).toHaveCount(1)
  // Newest first.
  await entries.first().click()
  await page.locator(".backup-restore-button").click()
  await page.locator(".backup-confirm-button").click()
  await expect(page.locator(".notice", { hasText: "Log data restored successfully" })).toBeVisible()
  await expect(page.locator(".modal-container")).toHaveCount(0)
}

test("restoring a backup brings the day's comments back to that moment", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await enableDayComments(page)
  await openTaskChute(page)
  const today = await todayKey(page)
  const month = today.slice(0, 7)

  await addDayComment(page, "Plan the week")
  await expect.poll(() => readDayComments(vaultDir, today)).toEqual(["Plan the week"])
  expect(backupFiles(vaultDir, month)).toEqual([])

  // The next write backs up the day state as it was: one set, both halves.
  await addDayComment(page, "Call the bank")
  await expect.poll(() => backupFiles(vaultDir, month)).toEqual([
    expect.stringMatching(/Z\.json$/u),
    expect.stringMatching(/Z\.state\.json$/u),
  ])

  // Change things after the backup: edit the first comment, add a third.
  await dayCommentTexts(page).filter({ hasText: "Plan the week" }).click()
  const editor = page.locator(".taskchute-day-comments .taskchute-comment-editor textarea")
  // The editor takes focus (caret at the end) a frame after it opens; type only after that.
  await expect(editor).toBeFocused()
  await editor.fill("Plan the month")
  await page.locator(".taskchute-day-comments .taskchute-comment-editor").getByRole("button", { name: "Save" }).click()
  await addDayComment(page, "Book the flight")
  await expect.poll(() => readDayComments(vaultDir, today).sort()).toEqual(["Book the flight", "Call the bank", "Plan the month"])

  await restoreNewestBackup(page)

  // The open view shows the day as it was when the backup was taken.
  await expect(dayCommentTexts(page)).toHaveText(["Plan the week"])
  expect(readDayComments(vaultDir, today)).toEqual(["Plan the week"])
  // And it stays that way after a fresh load.
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await expect(dayCommentTexts(page)).toHaveText(["Plan the week"])
})

test("restoring a backup taken before a routine was deleted for today brings it back", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await enableDayComments(page)
  const routinePath = await createDailyRoutine(page, "Morning review")
  await openTaskChute(page)
  const today = await todayKey(page)
  const month = today.slice(0, 7)

  await addDayComment(page, "Plan the week")
  await addDayComment(page, "Call the bank")
  await expect.poll(() => backupFiles(vaultDir, month)).toHaveLength(2)

  await deleteForToday(page, routinePath)
  // One interval, one set: deleting writes the day state and the log, but makes no second set.
  expect(backupFiles(vaultDir, month)).toHaveLength(2)

  await restoreNewestBackup(page)
  await expect(rowsOf(page, routinePath)).toHaveCount(1)
  await expect(dayCommentTexts(page)).toHaveText(["Plan the week"])
})

test("restoring a backup taken after a routine was deleted for today keeps it deleted", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await enableDayComments(page)
  // A short interval, so the write after the deletion takes a set of its own.
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.backupIntervalHours = 0.001
    await plugin.saveSettings()
  }, "taskchute-plus")
  const routinePath = await createDailyRoutine(page, "Morning review")
  await openTaskChute(page)
  const today = await todayKey(page)
  const month = today.slice(0, 7)

  await addDayComment(page, "Plan the week")
  await deleteForToday(page, routinePath)
  const before = backupFiles(vaultDir, month).length
  // Past the interval (3.6 s), the next write backs up the day with the routine deleted.
  await page.waitForTimeout(4_000)
  await addDayComment(page, "Skip the review today")
  await expect.poll(() => backupFiles(vaultDir, month).length).toBeGreaterThan(before)

  await reuseFromAddTask(page, "Morning review")
  await expect(rowsOf(page, routinePath)).toHaveCount(1)

  await restoreNewestBackup(page, { entries: "many" })

  // Deleted for today again; the comment written after the backup is gone.
  await expect(rowsOf(page, routinePath)).toHaveCount(0)
  await expect(dayCommentTexts(page)).toHaveText(["Plan the week"])
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await expect(rowsOf(page, routinePath)).toHaveCount(0)
})
