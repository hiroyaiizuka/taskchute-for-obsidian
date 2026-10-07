import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { TASK_FOLDER, openTaskChute, rowState, taskRow, todayKey } from "../helpers/aiTask"

// #181: comments written while working — the day's comments above the task
// list, and a running task's comments under its row.

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

test("a comment on the day is kept in the day state and shown again after reopening", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  await openTaskChute(page)
  const today = await todayKey(page)

  const input = page.locator(".taskchute-day-comments textarea")
  await input.click()
  await input.fill("Finish the draft before lunch")
  await input.press("Enter")

  await expect(page.locator(".taskchute-day-comments .taskchute-comment-text")).toHaveText(["Finish the draft before lunch"])
  await expect.poll(() => readDayComments(vaultDir, today).map((c) => c.text)).toEqual(["Finish the draft before lunch"])

  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
  await expect(page.locator(".taskchute-day-comments .taskchute-comment-text")).toHaveText(["Finish the draft before lunch"])
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
  const panelInput = page.locator(".taskchute-task-comments textarea")
  await expect(panelInput).toBeFocused()
  await panelInput.fill("Outline done")
  await panelInput.press("Enter")

  await expect(row.locator(".comment-button__count")).toHaveText("1")
  await expect.poll(() => readDayComments(vaultDir, today)).toEqual([
    expect.objectContaining({ text: "Outline done", instanceId: expect.any(String) }),
  ])

  await row.locator(".play-stop-button").click()
  await expect.poll(() => rowState(row)).toBe("done")
  await expect(page.locator(".taskchute-task-comments")).toHaveCount(0)

  await row.locator(".comment-button").click()
  const recap = page.locator(".taskchute-comment-recap")
  await expect(recap).toBeVisible()
  await expect(recap.locator(".taskchute-comment-text")).toHaveText(["Outline done"])
})
