import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow, todayKey, writeFakeClaude } from "../helpers/aiTask"

// #182: a task switches between human and AI from the ⚙️ menu.

async function createHumanTask(page: Page, title: string): Promise<string> {
  const today = await todayKey(page)
  const taskPath = `${TASK_FOLDER}/${title}.md`
  const content = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", "", "Notes written by hand.", ""].join("\n")
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

async function changeType(page: Page, taskPath: string, to: "human" | "ai", prompt?: string) {
  await taskRow(page, taskPath).locator(".settings-task-button").click()
  await page.locator(".task-settings-tooltip .tooltip-item", { hasText: "Change task type" }).click()
  const modal = page.locator(".modal-container")
  await expect(modal.locator(".task-type-group")).toBeVisible()
  await modal.locator(`.task-type-option[data-task-type="${to}"]`).click()
  if (prompt) await modal.locator(".ai-task-prompt-input").fill(prompt)
  await modal.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect(modal).toHaveCount(0)
}

test("a task switches to AI and back from the settings menu", async ({ obsidian }, testInfo) => {
  const { page, vaultDir } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"))
  const taskPath = await createHumanTask(page, "Write report")
  await openTaskChute(page)
  const row = taskRow(page, taskPath)
  await expect(row).toBeVisible()
  await expect(row.locator(".ai-task-controls")).toHaveCount(0)
  const read = () => fs.readFileSync(path.join(vaultDir, taskPath), "utf8")

  await changeType(page, taskPath, "ai", "Draft the report")
  await expect.poll(read).toContain("ai_task: true")
  expect(read()).toContain("Draft the report")
  expect(read()).toContain("Notes written by hand.")
  await expect(taskRow(page, taskPath).locator(".ai-task-controls")).toHaveCount(1)
  // Saving the change does not start the task.
  await page.waitForTimeout(500)
  expect(await rowState(taskRow(page, taskPath))).toBe("idle")

  await changeType(page, taskPath, "human")
  await expect.poll(read).not.toContain("ai_task")
  expect(read()).toContain("Draft the report")
  expect(read()).toContain("Notes written by hand.")
  await expect(taskRow(page, taskPath).locator(".ai-task-controls")).toHaveCount(0)
})
