import { PLUGIN_ID, TASK_FOLDER, aiRuns, enableAiTasks, openTaskChute, rowState, taskRow } from "../../helpers/aiTask"
import { realClaudePath, runIdOf, waitForClaude } from "../aiTerminal"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-395: an AI task that is not a routine starts by itself once its start
// time has come, once a day, as AI routines already do. Follows the issue's
// "done when" list. Recorded with the real Claude Code CLI of whoever records.

const ONE_OFF = "ニュースを要約する"
const LATER = "夕方のまとめ"
const ROUTINE = "毎朝の点検"
const oneOffPath = `${TASK_FOLDER}/${ONE_OFF}.md`
const laterPath = `${TASK_FOLDER}/${LATER}.md`
const routinePath = `${TASK_FOLDER}/${ROUTINE}.md`

const pad = (n: number) => String(n).padStart(2, "0")

function note(properties: string[], prompt: string): string {
  return ["---", "tags:", "  - task", ...properties, "ai_task: true", "ai_task_host: claude", "---", "", "## Prompt", "", prompt, ""].join("\n")
}

test("ai-ambient-start", async ({ obsidian, recorder }) => {
  test.setTimeout(300_000)
  const { page } = obsidian
  const now = new Date()
  test.skip(now.getHours() === 23 && now.getMinutes() >= 45, "too close to midnight")
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const due = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const later = now.getHours() >= 22 ? "23:59" : `${pad(now.getHours() + 2)}:${pad(now.getMinutes())}`

  await enableAiTasks(page, await realClaudePath(), "terminal")
  // The scheduler is already running and checks every minute. Until the first
  // chapter, its checks find nothing, so no task starts during setup.
  await page.evaluate((id) => {
    const plugin = window.app.plugins.plugins[id] as {
      aiTaskAmbientScheduler: { options: { findCandidates: (now: Date) => unknown } }
    }
    const options = plugin.aiTaskAmbientScheduler.options
    const find = options.findCandidates
    const w = window as unknown as { ambientReady?: boolean }
    options.findCandidates = (now) => (w.ambientReady ? find(now) : [])
  }, PLUGIN_ID)
  await createNotes(page, {
    [oneOffPath]: note([`target_date: "${today}"`, `scheduled_time: "${due}"`], "「ニュースの要約」とは何かを一文で説明してください。"),
    [laterPath]: note([`target_date: "${today}"`, `scheduled_time: "${later}"`], "一日の作業のまとめ方を一文で説明してください。"),
    [routinePath]: note(
      [
        "isRoutine: true",
        "routine_type: daily",
        "routine_interval: 1",
        "routine_enabled: true",
        `routine_start: "${today}"`,
        `scheduled_time: "${due}"`,
      ],
      "朝の点検で確かめることを 3 つ、箇条書きで挙げてください。",
    ),
  })
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)

  const oneOff = taskRow(page, oneOffPath)
  const laterRow = taskRow(page, laterPath)
  const routine = taskRow(page, routinePath)
  // A check during setup starts nothing.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await page.waitForTimeout(1_000)
  await expect.poll(() => rowState(oneOff)).toBe("idle")
  await expect.poll(() => rowState(laterRow)).toBe("idle")
  await expect.poll(() => rowState(routine)).toBe("idle")
  // The scheduler checks every minute while Obsidian runs, and whenever the
  // window gets focus. The recording uses focus to skip the wait.
  const checkNow = () => page.evaluate(() => window.dispatchEvent(new Event("focus")))
  const runsOf = async (path: string) => (await aiRuns(page)).filter((run) => run.taskPath === path).length

  await recorder.start(`開始時刻 ${due} の AI タスク 2 つと、${later} の AI タスク`, {
    sub: "「ニュースを要約する」はルーチンではない。Claude Code は本物です",
    say: `開始時刻が ${due} の AI タスクが 2 つと、${later} の AI タスクがあります。ニュースを要約するは、ルーチンではありません。`,
  })

  await recorder.chapter("① 自動実行の確認が走る", {
    sub: "開始時刻を過ぎた 2 つが、ルーチンでなくても自動で始まる",
    say: "自動実行の確認は、1 分ごとに走ります。録画では待ち時間を省くため、画面のフォーカスで確認させます。開始時刻を過ぎた 2 つが、ルーチンでなくても自動で始まります。",
  })
  await page.evaluate(() => {
    ;(window as unknown as { ambientReady?: boolean }).ambientReady = true
  })
  await checkNow()
  await expect.poll(() => rowState(oneOff), { timeout: 30_000 }).toBe("running")
  await expect.poll(() => rowState(routine), { timeout: 30_000 }).toBe("running")
  await waitForClaude(page, (await runIdOf(page, oneOffPath))!)

  await recorder.chapter("② 開始時刻がまだのタスク", { sub: `「${LATER}」（${later}）は未実行のまま` })
  await recorder.hover(laterRow)
  expect(await rowState(laterRow)).toBe("idle")
  expect(await runsOf(laterPath)).toBe(0)

  await recorder.chapter("③ 止めてから、もう一度確認が走る", {
    sub: "一度自動で動いたタスクは、同じ日にはもう始まらない",
    say: "ニュースを要約するを止めて、もう一度確認を走らせます。一度自動で動いたタスクは、その日の記録が残るので、同じ日にはもう始まりません。",
  })
  await recorder.click(oneOff.locator(".play-stop-button"))
  await expect.poll(() => rowState(oneOff)).toBe("done")
  // A stopped run leaves the run list; a second start would put it back.
  await expect.poll(() => runsOf(oneOffPath)).toBe(0)
  await checkNow()
  await recorder.pause(2_000)
  expect(await rowState(oneOff)).toBe("done")
  expect(await runsOf(oneOffPath)).toBe(0)
})
