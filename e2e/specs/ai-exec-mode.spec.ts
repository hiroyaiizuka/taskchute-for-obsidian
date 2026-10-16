import fs from "node:fs"
import path from "node:path"
import { expect, test } from "../fixtures"
import { TASK_FOLDER, enableAiTasks, openTaskChute, taskRow, todayKey, writeFakeClaude } from "../helpers/aiTask"

// LEV-315: every agent offers manual / auto / skip permissions. A new AI task
// starts in auto; a task that already exists keeps what its note says.

const readNote = (vaultDir: string, taskPath: string) => fs.readFileSync(path.join(vaultDir, taskPath), "utf8")
/** The note's properties block, where the execution mode lives. */
const frontmatterOf = (note: string) => /^---\n([\s\S]*?)\n---/.exec(note)?.[1] ?? ""

test("a new AI task starts in auto mode", async ({ obsidian }, testInfo) => {
  const { page, vaultDir } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "finishes-on-its-own"))
  await openTaskChute(page)

  await page.locator(".taskchute-view-root .add-task-button").click()
  const modal = page.locator(".modal-container")
  await modal.locator("input").first().fill("Review the PR")
  await modal.locator('.task-type-option[data-task-type="ai"]').click()
  await modal.locator(".ai-task-prompt-input").fill("Review the open pull request")
  await expect(modal.locator(".ai-task-command-preview code")).toContainText("claude --permission-mode auto")
  await modal.locator(".ai-task-advanced > summary").click()
  await expect(modal.locator(".ai-task-exec-mode")).toHaveValue("auto")
  await expect(modal.locator(".ai-task-exec-mode option")).toHaveText(["Manual", "Auto mode", "Skip permissions"])
  await modal.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect(modal).toHaveCount(0)

  await expect.poll(() => readNote(vaultDir, `${TASK_FOLDER}/Review the PR.md`)).toMatch(
    /ai_task_args:\n\s*- "?--permission-mode"?\n\s*- "?auto"?/,
  )
})

test("an existing AI task without execution-mode arguments is unchanged after opening and saving it", async ({ obsidian }, testInfo) => {
  const { page, vaultDir } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "finishes-on-its-own"))
  const today = await todayKey(page)
  const taskPath = `${TASK_FOLDER}/Older AI task.md`
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
    [
      TASK_FOLDER,
      taskPath,
      ["---", "tags:", "  - task", `target_date: "${today}"`, "ai_task: true", "ai_task_host: claude", "---", "", "## Prompt", "", "Summarize the notes.", ""].join("\n"),
    ] as const,
  )
  await openTaskChute(page)
  const before = frontmatterOf(readNote(vaultDir, taskPath))

  await taskRow(page, taskPath).locator(".ai-task-edit-button").click()
  const modal = page.locator(".modal-container")
  await modal.locator(".ai-task-advanced > summary").click()
  await expect(modal.locator(".ai-task-exec-mode")).toHaveValue("manual")
  await modal.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect(modal).toHaveCount(0)

  await page.waitForTimeout(500)
  // Saving rewrites the prompt section's markers, but the properties stay as they were.
  const after = frontmatterOf(readNote(vaultDir, taskPath))
  expect(after).not.toContain("ai_task_args")
  expect(after).toBe(before)
})
