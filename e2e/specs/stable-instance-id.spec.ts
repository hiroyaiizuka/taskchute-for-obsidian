import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import {
  TASK_FOLDER,
  aiRuns,
  createLinkedPair,
  enableAiTasks,
  openTaskChute,
  rowState,
  taskRow,
  todayKey,
  writeFakeClaude,
} from "../helpers/aiTask"

// A task's own instance for the day gets the same id on every load
// (`path_date_base`). These walk the flows that key something by that id
// across a reload of the view.

async function createNote(page: Page, title: string, lines: string[]): Promise<string> {
  const taskPath = `${TASK_FOLDER}/${title}.md`
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
    [TASK_FOLDER, taskPath, lines.join("\n")] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as { metadataCache: { getCache(path: string): { frontmatter?: unknown } | null } }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, taskPath)
  return taskPath
}

async function createTask(page: Page, title: string): Promise<string> {
  const today = await todayKey(page)
  return createNote(page, title, ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""])
}

async function createDailyRoutine(page: Page, title: string): Promise<string> {
  const today = await todayKey(page)
  return createNote(page, title, [
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
  ])
}

async function reopenView(page: Page) {
  await page.evaluate(() => window.app.workspace.detachLeavesOfType("taskchute-view"))
  await openTaskChute(page)
}

async function settingsItem(page: Page, taskPath: string, label: string) {
  await taskRow(page, taskPath).locator(".settings-task-button").click()
  await page.locator(".task-settings-tooltip .tooltip-item", { hasText: label }).click()
}

function readLogEntries(vaultDir: string, dateKey: string, taskPath: string) {
  const file = path.join(vaultDir, "TaskChute", "Log", `${dateKey.slice(0, 7)}-tasks.json`)
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    taskExecutions?: Record<string, Array<{ taskPath?: string; instanceId?: string; startTime?: string }>>
  }
  return (parsed.taskExecutions?.[dateKey] ?? []).filter((entry) => entry.taskPath === taskPath)
}

const rowsOf = (page: Page, taskPath: string) =>
  page.locator(`.taskchute-view-root .task-item[data-task-path="${taskPath}"]`)

test("done, reset, then run again the same day leaves one entry in the log", async ({ obsidian }) => {
  const { page, vaultDir } = obsidian
  const taskPath = await createTask(page, "Write report")
  await openTaskChute(page)
  const today = await todayKey(page)
  const row = () => taskRow(page, taskPath)

  await row().locator(".play-stop-button").click()
  await expect.poll(() => rowState(row())).toBe("running")
  await row().locator(".play-stop-button").click()
  await expect.poll(() => rowState(row())).toBe("done")
  await expect.poll(() => readLogEntries(vaultDir, today, taskPath).length, { timeout: 20_000 }).toBe(1)

  await settingsItem(page, taskPath, "Reset to not started")
  await expect.poll(() => rowState(row())).toBe("idle")
  await expect.poll(() => readLogEntries(vaultDir, today, taskPath).length, { timeout: 20_000 }).toBe(0)
  await reopenView(page)

  await row().locator(".play-stop-button").click()
  await expect.poll(() => rowState(row())).toBe("running")
  await row().locator(".play-stop-button").click()
  await expect.poll(() => rowState(row())).toBe("done")

  await expect.poll(() => readLogEntries(vaultDir, today, taskPath).length, { timeout: 20_000 }).toBe(1)
  // Still one entry after the view loads the log again.
  await reopenView(page)
  await expect(rowsOf(page, taskPath)).toHaveCount(1)
  expect(await rowState(row())).toBe("done")
  expect(readLogEntries(vaultDir, today, taskPath)).toHaveLength(1)
})

test("a routine deleted for today stays deleted after a reload, and comes back as one row when added again", async ({ obsidian }) => {
  const { page } = obsidian
  const routinePath = await createDailyRoutine(page, "Morning review")
  await openTaskChute(page)
  await expect(rowsOf(page, routinePath)).toHaveCount(1)

  await settingsItem(page, routinePath, "Delete task")
  await page.locator(".modal-container .mod-warning").click()
  await expect(rowsOf(page, routinePath)).toHaveCount(0)

  await reopenView(page)
  await expect(rowsOf(page, routinePath)).toHaveCount(0)

  // Add the same task again from the add-task modal: pick the suggestion, keep "Reuse".
  await page.locator(".taskchute-view-root .add-task-button").click()
  const name = page.locator(".modal-container input").first()
  await name.click()
  await name.pressSequentially("Morning rev", { delay: 30 })
  await page.locator(".suggestion-item", { hasText: "Morning review" }).first().click()
  await page.locator(".modal-container").getByRole("button", { name: "Save" }).click()
  await expect(page.locator(".modal-container")).toHaveCount(0)
  // The routine's own instance comes back, with no duplicate beside it.
  await expect(rowsOf(page, routinePath)).toHaveCount(1)

  await reopenView(page)
  await expect(rowsOf(page, routinePath)).toHaveCount(1)
})

test("a task moved to tomorrow and back shows on today again and can be run", async ({ obsidian }) => {
  const { page } = obsidian
  const taskPath = await createTask(page, "Draft slides")
  await openTaskChute(page)
  const today = await todayKey(page)
  const tomorrow = await page.evaluate(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
  const move = (dateStr: string) =>
    page.evaluate(
      async ([p, date]) => {
        const leaf = window.app.workspace.getLeavesOfType("taskchute-view")[0] as {
          view: {
            taskInstances: Array<{ task: { path: string } }>
            taskScheduleController: { moveTaskToDate(inst: unknown, date: string): Promise<boolean> }
          }
        }
        const inst = leaf.view.taskInstances.find((candidate) => candidate.task.path === p)
        return leaf.view.taskScheduleController.moveTaskToDate(inst, date)
      },
      [taskPath, dateStr] as const,
    )

  expect(await move(tomorrow)).toBe(true)
  await expect(rowsOf(page, taskPath)).toHaveCount(0)
  await page.locator(".taskchute-view-root .date-nav-arrow").last().click()
  await expect(rowsOf(page, taskPath)).toHaveCount(1)
  expect(await move(today)).toBe(true)
  await page.locator(".taskchute-view-root .date-nav-arrow").first().click()

  await expect(rowsOf(page, taskPath)).toHaveCount(1)
  await taskRow(page, taskPath).locator(".play-stop-button").click()
  await expect.poll(() => rowState(taskRow(page, taskPath))).toBe("running")
})

test("a running task stays one running row after the view reloads", async ({ obsidian }) => {
  const { page } = obsidian
  const taskPath = await createTask(page, "Read papers")
  await openTaskChute(page)
  await taskRow(page, taskPath).locator(".play-stop-button").click()
  await expect.poll(() => rowState(taskRow(page, taskPath))).toBe("running")

  await reopenView(page)
  await expect(rowsOf(page, taskPath)).toHaveCount(1)
  expect(await rowState(taskRow(page, taskPath))).toBe("running")
  await reopenView(page)
  await expect(rowsOf(page, taskPath)).toHaveCount(1)
  expect(await rowState(taskRow(page, taskPath))).toBe("running")
})

test("a linked human task started again after reset and a reload still starts its AI routine", async ({ obsidian }, testInfo) => {
  const { page } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"))
  const pair = await createLinkedPair(page)
  await openTaskChute(page)
  const human = () => taskRow(page, pair.humanPath)
  const ai = () => taskRow(page, pair.aiPath)

  await human().locator(".play-stop-button").click()
  await expect.poll(() => rowState(ai())).toBe("running")
  await human().locator(".play-stop-button").click()
  await expect.poll(() => rowState(human())).toBe("done")
  await expect.poll(() => rowState(ai())).toBe("done")

  await settingsItem(page, pair.humanPath, "Reset to not started")
  await expect.poll(() => rowState(human())).toBe("idle")
  await expect.poll(() => rowState(ai())).toBe("idle")
  await reopenView(page)

  await human().locator(".play-stop-button").click()
  await expect.poll(() => rowState(human())).toBe("running")
  await expect.poll(() => rowState(ai())).toBe("running")
  await expect.poll(() => aiRuns(page)).toEqual([{ taskPath: pair.aiPath, status: "running" }])
})
