import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow, todayKey } from "../helpers/aiTask"

// LEV-390: a task note's working folder is a request. A folder this device
// has not approved is asked about when the user starts the task with ▶, and
// once allowed, other tasks in that folder start without asking.

/** A stand-in CLI that records the folder each run starts in, one per line. */
function writeCwdRecorder(dir: string): { bin: string; cwdFile: string } {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, "claude")
  const cwdFile = path.join(dir, "cwd.txt")
  fs.writeFileSync(bin, `#!/bin/sh\npwd -P >> '${cwdFile}'\nexec sleep 60\n`, { mode: 0o755 })
  return { bin, cwdFile }
}

function recordedFolders(cwdFile: string): string[] {
  if (!fs.existsSync(cwdFile)) return []
  return fs.readFileSync(cwdFile, "utf8").split("\n").filter((line) => line.length > 0)
}

async function createAiTask(page: Page, name: string, cwd: string): Promise<string> {
  const taskPath = `${TASK_FOLDER}/${name}.md`
  const note = [
    "---",
    "tags:",
    "  - task",
    `target_date: "${await todayKey(page)}"`,
    "ai_task: true",
    "ai_task_host: claude",
    `ai_task_cwd: ${JSON.stringify(cwd)}`,
    "---",
    "",
    "## Prompt",
    "",
    `${name}.`,
    "",
  ].join("\n")
  await page.evaluate(
    async ([folder, file, content]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(file, content)
    },
    [TASK_FOLDER, taskPath, note] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as {
      metadataCache: { getCache(path: string): { frontmatter?: unknown } | null }
    }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, taskPath)
  return taskPath
}

test("a working folder this device has not approved is asked about on ▶, once", async ({ obsidian }, testInfo) => {
  const { page } = obsidian
  const recorder = writeCwdRecorder(testInfo.outputPath("bin"))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(testInfo.outputPath(), "outside-")))
  await enableAiTasks(page, recorder.bin)
  const first = await createAiTask(page, "Repo cleanup", outside)
  const second = await createAiTask(page, "Repo notes", outside)
  await openTaskChute(page)

  const dialog = page.locator(".modal-container .taskchute-confirm-modal")

  // Asked, and Cancel: nothing starts.
  await taskRow(page, first).locator(".play-stop-button").click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Allow the working folder of "Repo cleanup" on this device?')
  await expect(dialog).toContainText(outside)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => rowState(taskRow(page, first))).toBe("idle")
  expect(recordedFolders(recorder.cwdFile)).toEqual([])

  // Asked again, and allowed: it runs in that folder.
  await taskRow(page, first).locator(".play-stop-button").click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Allow this folder" }).click()
  await expect.poll(() => recordedFolders(recorder.cwdFile), { timeout: 20_000 }).toEqual([outside])

  // Another task in the same folder: not asked.
  await taskRow(page, second).locator(".play-stop-button").click()
  await expect.poll(() => recordedFolders(recorder.cwdFile).length, { timeout: 20_000 }).toBe(2)
  await expect(dialog).toHaveCount(0)
})
