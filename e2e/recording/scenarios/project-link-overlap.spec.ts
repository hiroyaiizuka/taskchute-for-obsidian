import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, rowState, taskRow, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-414: with a long project name, the project box was filled by the name
// alone and the 🔗 beside it was pushed out, under the start time. Clicking
// the 🔗 then opened the start-time editor instead of the project note.
// The same script records the build before the fix and after it, at three
// screen sizes; TASKCHUTE_RECORD_PHASE=before expects the old overlap.
// Nothing is faked: the tasks are run through the plugin before recording.
// iPad and iPhone are Obsidian's own mobile layout (emulateMobile) with touch
// emulation, in a desktop window: taps are mouse clicks, and there is no
// on-screen keyboard.

const BEFORE = process.env.TASKCHUTE_RECORD_PHASE === "before"
const LONG_PROJECT = "マーケAI全自動化、10X集客の仕組みを作る"
const SHORT_PROJECT = "10X行動処理エキスパート講座"
const RUNNING = "10X戦略をAddnessで組む"
const DONE = "講座の構成・コンセプト検討"
const path = (title: string) => `${TASK_FOLDER}/${title}.md`
const projectNote = (name: string) => `Projects/Project - ${name}.md`
const SETUP = { timeout: 10_000 }

interface Device {
  name: string
  label: string
  size: { width: number; height: number }
  mobile: "phone" | "tablet" | null
  /** Whether the task list is wide enough to show the project at all (over 900px). */
  showsProject: boolean
}

const DEVICES: Device[] = [
  { name: "mac", label: "macOS（1280×800）", size: { width: 1280, height: 800 }, mobile: null, showsProject: true },
  { name: "ipad", label: "iPad 横向き（1180×820）", size: { width: 1180, height: 820 }, mobile: "tablet", showsProject: true },
  { name: "iphone", label: "iPhone（390×844）", size: { width: 390, height: 844 }, mobile: "phone", showsProject: false },
]

interface Layout {
  /** The 🔗 ends before the start time begins. */
  clear: boolean
  /** What a click on the middle of the 🔗 lands on. */
  hit: "link" | "start-time" | "other"
}

async function layout(page: Page, title: string): Promise<Layout> {
  return taskRow(page, path(title)).evaluate((row) => {
    const link = row.querySelector(".taskchute-external-link")!.getBoundingClientRect()
    const time = row.querySelector(".task-time-range")!.getBoundingClientRect()
    const target = document.elementFromPoint(link.left + link.width / 2, link.top + link.height / 2)
    const hit = target?.closest(".taskchute-external-link")
      ? "link"
      : target?.closest(".task-time-start")
        ? "start-time"
        : "other"
    return { clear: link.right <= time.left, hit }
  })
}

/** Files of the notes open in the main area. */
async function openedNotes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const files: string[] = []
    const workspace = window.app.workspace as unknown as {
      iterateRootLeaves(cb: (leaf: { view: { file?: { path: string } } }) => void): void
    }
    workspace.iterateRootLeaves((leaf) => {
      if (leaf.view.file) files.push(leaf.view.file.path)
    })
    return files
  })
}

// A desktop gets a small popup; Obsidian's mobile layout gets a wheel picker.
const timePopup = (page: Page) => page.locator(".taskchute-time-popup, .taskchute-mobile-time-picker")

async function closeTimePicker(page: Page): Promise<void> {
  const cancel = page.locator(".taskchute-mobile-time-picker-btn-cancel")
  if (await cancel.isVisible()) await cancel.click()
  else await page.keyboard.press("Escape")
  await expect(timePopup(page)).toHaveCount(0)
}

async function emulate(page: Page, device: Device): Promise<void> {
  if (!device.mobile) return
  await page.evaluate(({ width, height }) => {
    const host = window as unknown as {
      electron?: { remote?: { getCurrentWindow?: () => { setContentSize?: (w: number, h: number) => void } } }
    }
    host.electron?.remote?.getCurrentWindow?.()?.setContentSize?.(width, height)
  }, device.size)
  await page.evaluate(() => (window.app as unknown as { emulateMobile(on: boolean): void }).emulateMobile(true))
  await page.waitForFunction((kind) => document.body.classList.contains(`is-${kind}`), device.mobile, SETUP)
  await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, SETUP)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
}

for (const device of DEVICES) {
  test(`project-link-overlap-${device.name}`, async ({ obsidian, recorder }) => {
    test.setTimeout(180_000)
    const { page } = obsidian
    await emulate(page, device)
    await page.evaluate((id) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
      plugin.settings.projectsFolder = "Projects"
    }, PLUGIN_ID)
    const today = await todayKey(page)
    const task = (project: string) =>
      ["---", "tags:", "  - task", `target_date: "${today}"`, `project: "[[Project - ${project}]]"`, "---", ""].join("\n")
    await createNotes(page, {
      [projectNote(LONG_PROJECT)]: "---\nstatus: todo\n---\n",
      [projectNote(SHORT_PROJECT)]: "---\nstatus: todo\n---\n",
      [path(DONE)]: task(SHORT_PROJECT),
      [path(RUNNING)]: task(LONG_PROJECT),
    })
    await openTaskChute(page)
    await expect(page.locator(".taskchute-view-root .task-item")).toHaveCount(2, SETUP)

    // One done, one running, the way the report's two screenshots show them.
    const play = (title: string) => taskRow(page, path(title)).locator(".play-stop-button")
    await play(DONE).click(SETUP)
    await expect.poll(() => rowState(taskRow(page, path(DONE))), SETUP).toBe("running")
    await play(DONE).click(SETUP)
    await expect.poll(() => rowState(taskRow(page, path(DONE))), SETUP).toBe("done")
    await play(RUNNING).click(SETUP)
    await expect.poll(() => rowState(taskRow(page, path(RUNNING))), SETUP).toBe("running")

    const phase = BEFORE ? "修正前（3.0.4）" : "修正後"
    const sub = `LEV-414 · ${phase} · ${device.label}`
    const linkButton = taskRow(page, path(RUNNING)).locator(".taskchute-external-link")

    if (!device.showsProject) {
      await recorder.start("iPhone の幅では、プロジェクトの枠を出さない", { sub, size: device.size })
      await recorder.chapter("① プロジェクト名が長いタスクの行を見る", {
        sub: "一覧が狭いのでプロジェクトと 🔗 は出ない。重なりは起きない",
      })
      await expect(linkButton).toBeHidden()
      await recorder.pause(1500)
    } else {
      await recorder.start(
        BEFORE ? "修正前: プロジェクト名が長いと 🔗 が開始時刻に重なる" : "修正後: 🔗 と開始時刻が重ならない",
        { sub, size: device.size },
      )

      await recorder.chapter("① プロジェクト名が長いタスクの行を見る", {
        sub: BEFORE ? "🔗 が開始時刻の上に重なっている" : "名前は「…」で省略され、🔗 は開始時刻の手前に収まる",
      })
      await recorder.hover(taskRow(page, path(RUNNING)).locator(".taskchute-project-button"))
      for (const title of [RUNNING, DONE]) {
        expect((await layout(page, title)).clear).toBe(!BEFORE)
      }
      await recorder.pause(1500)

      await recorder.chapter("② 🔗 を押す", {
        sub: BEFORE ? "報告の症状：開始時刻の入力が開いてしまう" : "プロジェクトのノートが開く",
      })
      const notesBefore = await openedNotes(page)
      expect((await layout(page, RUNNING)).hit).toBe(BEFORE ? "start-time" : "link")
      await recorder.click(linkButton)
      if (BEFORE) {
        await expect(timePopup(page)).toBeVisible()
        expect(await openedNotes(page)).toEqual(notesBefore)
        await recorder.pause(1500)
        await closeTimePicker(page)
      } else {
        await expect.poll(() => openedNotes(page)).toContain(projectNote(LONG_PROJECT))
        await expect(timePopup(page)).toHaveCount(0)
        await recorder.pause(1500)
        // Back to the list for the next scene.
        if (!(await taskRow(page, path(RUNNING)).isVisible())) await openTaskChute(page)
      }
    }

    await recorder.chapter(`${device.showsProject ? "③" : "②"} 開始時刻を押す`, {
      sub: "開始時刻の入力が開く（これは今までどおり）",
    })
    await recorder.click(taskRow(page, path(RUNNING)).locator(".task-time-start"))
    await expect(timePopup(page)).toBeVisible()
    await recorder.pause(1200)
    await closeTimePicker(page)
  })
}
