import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-417: a student reported that idle tasks carried over from an earlier
// time slot are mixed one by one with the tasks of the slot they move into,
// instead of staying together in their own order.
// This scenario reproduces the report as it happens: nothing is faked. The
// time slots are set around the real clock so that a slot boundary is crossed
// a minute or so into the recording, and the plugin's own boundary check
// moves the idle tasks. TASKCHUTE_RECORD_PHASE=before records the build
// before the fix and expects the mixed order; otherwise the carried tasks are
// expected as one block above the current slot's own.

const BEFORE = process.env.TASKCHUTE_RECORD_PHASE === "before"
const A = ["A-1 メール確認", "A-2 日報を書く", "A-3 資料の下書き"]
const B = ["B-1 除湿機の水", "B-2 本番読書", "B-3 散歩"]
const SETUP = { timeout: 10_000 }
const pad = (n: number) => String(n).padStart(2, "0")
const hm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
const label = (minutes: number) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`

/** The list as shown: slot headers and task names, top to bottom. */
async function listed(page: Page): Promise<string[]> {
  return page.locator(".taskchute-view-root").evaluate((root) =>
    Array.from(root.querySelectorAll(".time-slot-header, .task-item")).map((el) => {
      if (el.classList.contains("time-slot-header")) {
        const text = el.querySelector(".tc-slot-label")?.textContent ?? el.textContent ?? ""
        return `# ${text.trim()}`
      }
      const path = (el as HTMLElement).dataset.taskPath ?? ""
      return path.replace(/^.*\//, "").replace(/\.md$/, "")
    }),
  )
}

/** Task names under the slot header whose label is `slot`. */
function tasksIn(list: string[], slot: string): string[] {
  const start = list.indexOf(`# ${slot}`)
  if (start < 0) return []
  const rest = list.slice(start + 1)
  const end = rest.findIndex((entry) => entry.startsWith("# "))
  return end < 0 ? rest : rest.slice(0, end)
}

test("carryover-order-mixed", async ({ obsidian, recorder }) => {
  test.setTimeout(300_000)
  const { page } = obsidian

  // The boundary is the next whole minute at least 45 s away, so the setup and
  // the first scenes are done before it passes.
  const now = await page.evaluate(() => {
    const d = new Date()
    return { minutes: d.getHours() * 60 + d.getMinutes(), seconds: d.getSeconds() }
  })
  test.skip(now.minutes < 60 || now.minutes > 21 * 60, "needs room before and after the boundary")
  const boundary = now.minutes + (now.seconds < 15 ? 1 : 2)
  const end = boundary + 60
  const slotA = `0:00-${label(boundary)}`
  const slotB = `${label(boundary)}-${label(end)}`

  await page.evaluate(
    async ({ id, sections }) => {
      const plugin = window.app.plugins.plugins[id] as {
        settings: Record<string, unknown>
        saveSettings(): Promise<void>
      }
      plugin.settings.customSections = sections
      await plugin.saveSettings()
    },
    {
      id: PLUGIN_ID,
      sections: [
        { hour: 0, minute: 0 },
        { hour: Math.floor(boundary / 60), minute: boundary % 60 },
        { hour: Math.floor(end / 60), minute: end % 60 },
      ],
    },
  )

  const today = await todayKey(page)
  const task = (time: string) =>
    ["---", "tags:", "  - task", `target_date: "${today}"`, `scheduled_time: "${time}"`, "---", ""].join("\n")
  const notes: Record<string, string> = {}
  A.forEach((name, i) => (notes[`${TASK_FOLDER}/${name}.md`] = task(hm(30 + i * 10))))
  B.forEach((name, i) => (notes[`${TASK_FOLDER}/${name}.md`] = task(hm(boundary + 10 + i * 10))))
  await createNotes(page, notes)
  await openTaskChute(page)
  await expect(page.locator(".taskchute-view-root .task-item")).toHaveCount(6, SETUP)
  await expect.poll(() => listed(page).then((l) => tasksIn(l, slotA)), SETUP).toEqual(A)
  await expect.poll(() => listed(page).then((l) => tasksIn(l, slotB)), SETUP).toEqual(B)

  await recorder.start("時間帯をまたぐと、持ち越したタスクの並びが混ざるかを確かめる", {
    sub: `LEV-417 の再現。時間帯は ${slotA} と ${slotB}。偽物は使わず、本物の時計で境目をまたぐ`,
  })

  await recorder.chapter(`① いまの時間帯（${slotA}）に A のタスクが 3 つある`, {
    sub: `次の時間帯（${slotB}）には B のタスクが 3 つ。どれもまだ実行していない`,
  })
  await recorder.hover(page.locator(".taskchute-view-root .task-item").first())
  await recorder.pause(1500)

  await recorder.chapter(`② 実行しないまま、境目の ${label(boundary)} を待つ`, {
    sub: "境目を過ぎると、A のタスクは今の時間帯へ持ち越される",
  })
  await expect
    .poll(() => listed(page).then((l) => tasksIn(l, slotA).length), { timeout: 150_000, intervals: [1000] })
    .toBe(0)

  if (BEFORE) {
    await recorder.chapter("③ 持ち越した A と、B のタスクが 1 つずつ交互に並ぶ", {
      sub: "期待は A-1〜A-3 がまとまって並ぶこと。実際は A と B が混ざる",
      say: "持ち越した A と B のタスクが、1つずつ交互に並びました。A がまとまって並ぶのが期待した動きです。",
    })
    await expect
      .poll(() => listed(page).then((l) => tasksIn(l, slotB)), SETUP)
      .toEqual([A[0], B[0], A[1], B[1], A[2], B[2]])
  } else {
    await recorder.chapter("③ 持ち越した A が元の順のまま、B の上にまとまって並ぶ", {
      sub: "A-1, A-2, A-3, B-1, B-2, B-3 の順。1 日の予定の順が崩れない",
      say: "持ち越した A のタスクが、元の順番のまま、B の上にまとまって並びました。",
    })
    await expect.poll(() => listed(page).then((l) => tasksIn(l, slotB)), SETUP).toEqual([...A, ...B])
  }
  await recorder.hover(page.locator(".taskchute-view-root .task-item").nth(2))
  await recorder.pause(2500)
})
