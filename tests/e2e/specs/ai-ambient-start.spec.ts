import { expect, test } from "../fixtures"
import { TASK_FOLDER, aiRuns, enableAiTasks, openTaskChute, rowState, taskRow, todayKey, writeFakeClaude } from "../helpers/aiTask"

// LEV-395: an AI task that is not a routine starts by itself once its start
// time has come on its own day, as AI routines already do; one whose time has
// not come stays put.

const DUE = `${TASK_FOLDER}/Due one-off.md`
const LATER = `${TASK_FOLDER}/Later one-off.md`

function aiTaskNote(day: string, time: string): string {
  return [
    "---",
    "tags:",
    "  - task",
    `target_date: "${day}"`,
    `scheduled_time: "${time}"`,
    "ai_task: true",
    "ai_task_host: claude",
    "---",
    "",
    "## Prompt",
    "",
    "Summarize the notes.",
    "",
  ].join("\n")
}

test("an AI task that is not a routine starts by itself once its start time has come", async ({ obsidian }, testInfo) => {
  const { page } = obsidian
  const clock = await page.evaluate(() => {
    const d = new Date()
    return { hours: d.getHours(), minutes: d.getMinutes() }
  })
  // The later task needs a time still to come today.
  test.skip(clock.hours === 23 && clock.minutes >= 50, "too close to midnight")
  const pad = (n: number) => String(n).padStart(2, "0")
  const now = `${pad(clock.hours)}:${pad(clock.minutes)}`
  const later = `${pad(Math.min(clock.hours + 2, 23))}:${clock.hours + 2 > 23 ? "59" : pad(clock.minutes)}`

  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"))
  const today = await todayKey(page)
  await page.evaluate(
    async ([folder, notes]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      for (const [file, data] of notes) await vault.create(file, data)
    },
    [TASK_FOLDER, [[DUE, aiTaskNote(today, now)], [LATER, aiTaskNote(today, later)]]] as const,
  )
  await openTaskChute(page)
  await expect(taskRow(page, LATER)).toBeVisible()

  // The scheduler checks every minute, and whenever the window gets focus.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))

  // A due task starts within a moment; a short timeout makes a wrong start
  // time fail fast instead of waiting.
  await expect.poll(() => rowState(taskRow(page, DUE)), { timeout: 10_000 }).toBe("running")
  await expect.poll(async () => (await aiRuns(page)).map((run) => run.taskPath)).toEqual([DUE])
  // Give a wrong start of the later task time to show before checking.
  await page.waitForTimeout(1_500)
  expect(await rowState(taskRow(page, LATER))).toBe("idle")
  expect((await aiRuns(page)).map((run) => run.taskPath)).toEqual([DUE])
})
