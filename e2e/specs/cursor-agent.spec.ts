import fs from "node:fs"
import path from "node:path"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, aiRunLogStatuses, aiRuns, enableAiTasks, openTaskChute, taskRow, writeFakeClaude } from "../helpers/aiTask"

// LEV-313: Cursor is a third agent. A task made with it in the add-task
// modal runs the Cursor CLI (a stand-in here) headlessly.

/**
 * A stand-in for `cursor-agent`: records its argv one per line, then prints
 * stream-json shaped like the real CLI's (2026.10.01) and exits 0.
 */
function writeFakeCursor(dir: string): { bin: string; argvFile: string } {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, "cursor-agent")
  const argvFile = path.join(dir, "argv.txt")
  const lines = [
    `{"type":"system","subtype":"init","session_id":"e2e-cursor","model":"Auto","permissionMode":"default"}`,
    `{"type":"thinking","subtype":"delta","text":"…","session_id":"e2e-cursor"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reviewed by fake cursor"}]},"session_id":"e2e-cursor"}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"e2e-cursor"}`,
  ]
  const body = [
    `printf '%s\\n' "$@" > '${argvFile}'`,
    ...lines.map((line) => `echo '${line}'`),
    "sleep 1",
    "exit 0",
  ].join("\n")
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return { bin, argvFile }
}

test("a task made with Cursor in the add-task modal runs the Cursor CLI", async ({ obsidian }, testInfo) => {
  const { page, vaultDir } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "finishes-on-its-own"))
  const cursor = writeFakeCursor(testInfo.outputPath("cursor-bin"))
  await page.evaluate(
    ([id, bin]) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
      plugin.settings.aiTaskCursorPath = bin
    },
    [PLUGIN_ID, cursor.bin] as const,
  )
  await openTaskChute(page)

  await page.locator(".taskchute-view-root .add-task-button").click()
  const modal = page.locator(".modal-container")
  await modal.locator("input").first().fill("Review with Cursor")
  await modal.locator('.task-type-option[data-task-type="ai"]').click()
  await modal.locator('.ai-task-agent-card[data-ai-host="cursor"]').click()
  await expect(modal.locator('.ai-task-agent-card[data-ai-host="cursor"]')).toHaveClass(/is-selected/)
  await modal.locator(".ai-task-advanced > summary").click()
  // A new task starts in auto mode; nothing to choose.
  await expect(modal.locator(".ai-task-exec-mode")).toHaveValue("auto")
  // Trusting the folder is opt-in (off by default).
  await expect(modal.locator(".ai-task-trust__checkbox")).not.toBeChecked()
  await modal.locator(".ai-task-trust__checkbox").check()
  await modal.locator(".ai-task-prompt-input").fill("Review the open pull request")
  await expect(modal.locator(".ai-task-command-preview code")).toContainText("cursor-agent")
  await modal.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expect(modal).toHaveCount(0)

  const taskPath = "TaskChute/Task/Review with Cursor.md"
  const note = () => fs.readFileSync(path.join(vaultDir, taskPath), "utf8")
  await expect.poll(note).toContain("ai_task_host: cursor")
  expect(note()).toMatch(/- "?--sandbox"?\n\s*- "?disabled"?/)

  await taskRow(page, taskPath).locator(".play-stop-button").click()
  await expect.poll(() => aiRunLogStatuses(vaultDir), { timeout: 20_000 }).toEqual({ [taskPath]: "succeeded" })
  expect(await aiRuns(page)).toEqual([expect.objectContaining({ taskPath })])

  const argv = fs.readFileSync(cursor.argvFile, "utf8").trimEnd().split("\n")
  expect(argv.slice(0, 3)).toEqual(["-p", "--output-format", "stream-json"])
  expect(argv).toContain("--trust")
  expect(argv.join(" ")).toContain("--sandbox disabled")
  expect(argv.slice(-2)).toEqual(["--", expect.stringContaining("Review the open pull request")])
})
