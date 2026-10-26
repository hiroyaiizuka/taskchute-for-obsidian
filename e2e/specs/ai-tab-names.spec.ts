import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, enableAiTasks, openTaskChute, taskRow, todayKey, writeFakeClaude, skipWithoutBroker } from "../helpers/aiTask"

// LEV-376: a tab says what it holds. An AI task's tab carries the task's name
// (the same as its sidebar row); a + terminal says "Terminal" until a program
// runs in it, then the title that program set, and "Terminal" again once the
// shell is back at its prompt.
test.use({ isolatedHome: true })

const TASK_NAME = "AI daily review"

async function createAiTask(page: Page): Promise<string> {
  const taskPath = `${TASK_FOLDER}/${TASK_NAME}.md`
  const note = [
    "---",
    "tags:",
    "  - task",
    `target_date: "${await todayKey(page)}"`,
    "ai_task: true",
    "ai_task_host: claude",
    "---",
    "",
    "## Prompt",
    "",
    "Review the day.",
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

/** The live shell session's run id (the + terminal). */
async function shellRunId(page: Page): Promise<string | null> {
  return page.evaluate((id) => {
    const plugin = window.app.plugins.plugins[id] as {
      aiTaskManager?: { getRuns(): Array<{ id: string; host: string; status: string }> }
    }
    return plugin.aiTaskManager?.getRuns().find((run) => run.host === "shell" && run.status === "running")?.id ?? null
  }, PLUGIN_ID)
}

/** Everything the session printed so far (the manager replays its buffer on subscribe). */
async function terminalOutput(page: Page, runId: string): Promise<string> {
  return page.evaluate(
    ([id, run]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { onTerminalData(runId: string, listener: (chunk: string) => void): () => void }
      }
      let text = ""
      const unsubscribe = plugin.aiTaskManager.onTerminalData(run, (chunk) => {
        text += chunk
      })
      unsubscribe()
      return text
    },
    [PLUGIN_ID, runId] as const,
  )
}

async function typeInto(page: Page, runId: string, data: string): Promise<void> {
  await page.evaluate(
    ([id, run, input]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager: { sendTerminalInput(runId: string, data: string): void }
      }
      plugin.aiTaskManager.sendTerminalInput(run, input)
    },
    [PLUGIN_ID, runId, data] as const,
  )
}

test("an AI task's tab shows the task name, and a + terminal is named after what runs in it", async ({ obsidian, home }, testInfo) => {
  skipWithoutBroker()
  const { page } = obsidian
  // A quiet login shell: no first-run wizard, a prompt that is easy to wait for.
  fs.writeFileSync(path.join(home!, ".zshrc"), "PROMPT='e2e$ '\n")
  fs.writeFileSync(path.join(home!, ".bashrc"), "PS1='e2e$ '\n")
  // bash starts as a login shell (-i -l), which reads ~/.bash_profile, not
  // ~/.bashrc; without it the system's /etc/bash.bashrc prompt stays.
  fs.writeFileSync(path.join(home!, ".bash_profile"), "PS1='e2e$ '\n")
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"))
  const taskPath = await createAiTask(page)
  await openTaskChute(page)

  await taskRow(page, taskPath).locator(".play-stop-button").click()
  const taskTab = page.locator(".ai-run-pane__tab").first()
  await expect(taskTab.locator(".ai-run-pane__tab-label")).toHaveText(TASK_NAME)
  await expect(taskTab.locator(".ai-run-pane__tab-label")).toHaveAttribute("title", TASK_NAME)
  await expect(page.locator(".ai-run-pane__run .ai-run-pane__run-name").first()).toHaveText(TASK_NAME)

  // + opens a shell next to the task's tab: just "Terminal".
  await page.locator(".ai-run-pane__add").first().click()
  await expect.poll(() => shellRunId(page), { timeout: 15_000 }).not.toBeNull()
  const runId = (await shellRunId(page))!
  const shellLabel = page.locator(`.ai-run-pane__tab[data-run-id="${runId}"] .ai-run-pane__tab-label`)
  await expect(shellLabel).toHaveText("Terminal")
  await expect.poll(() => terminalOutput(page, runId), { timeout: 15_000 }).toContain("e2e$")

  // A program names itself and keeps running: the tab takes its title.
  await typeInto(page, runId, "printf '\\033]0;E2E title\\007'; sleep 8\r")
  await expect(shellLabel).toHaveText("E2E title", { timeout: 10_000 })

  // It ends; the shell is back at its prompt: "Terminal" again.
  await expect(shellLabel).toHaveText("Terminal", { timeout: 20_000 })
  // The task's tab never changed.
  await expect(taskTab.locator(".ai-run-pane__tab-label")).toHaveText(TASK_NAME)
})
