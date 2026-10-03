import { expect, test } from "../fixtures"
import {
  type FakeClaudeBehaviour,
  aiRunLogStatuses,
  aiRuns,
  completedTaskPaths,
  createLinkedPair,
  enableAiTasks,
  openTaskChute,
  readRunningTaskPaths,
  rowState,
  taskRow,
  writeFakeClaude,
} from "../helpers/aiTask"

// #183: a human task and the AI routine linked to it through `obsidian_sync`
// move together, with the real AiTaskManager spawning a fake `claude` CLI.

test.describe("human task and linked AI routine", () => {
  async function setUp(
    obsidian: { page: import("@playwright/test").Page },
    behaviour: FakeClaudeBehaviour,
    binDir: string,
  ) {
    const { page } = obsidian
    await enableAiTasks(page, writeFakeClaude(binDir, behaviour))
    const pair = await createLinkedPair(page)
    await openTaskChute(page)
    const human = taskRow(page, pair.humanPath)
    const ai = taskRow(page, pair.aiPath)
    await expect(human).toBeVisible()
    await expect(ai).toBeVisible()
    expect(await rowState(human)).toBe("idle")
    expect(await rowState(ai)).toBe("idle")
    return { ...pair, human, ai }
  }

  test("starting and stopping the human task drives the AI routine", async ({ obsidian }, testInfo) => {
    const { page, vaultDir } = obsidian
    const { human, ai, humanPath, aiPath } = await setUp(obsidian, "runs-until-killed", testInfo.outputPath("bin"))

    await human.locator(".play-stop-button").click()

    await expect.poll(() => rowState(ai)).toBe("running")
    expect(await rowState(human)).toBe("running")
    await expect.poll(() => aiRuns(page)).toEqual([{ taskPath: aiPath, status: "running" }])
    await expect
      .poll(() => readRunningTaskPaths(vaultDir).sort())
      .toEqual([aiPath, humanPath].sort())

    await human.locator(".play-stop-button").click()

    await expect.poll(() => rowState(human)).toBe("done")
    await expect.poll(() => rowState(ai)).toBe("done")
    await expect.poll(() => aiRunLogStatuses(vaultDir)).toEqual({ [aiPath]: "stopped" })
    await expect.poll(() => readRunningTaskPaths(vaultDir)).toEqual([])
    expect(completedTaskPaths(vaultDir).sort()).toEqual([aiPath, humanPath].sort())
  })

  test("starting the AI routine and closing its run drives the human task", async ({ obsidian }, testInfo) => {
    const { page, vaultDir } = obsidian
    const { human, ai, humanPath, aiPath } = await setUp(obsidian, "runs-until-killed", testInfo.outputPath("bin"))

    await ai.locator(".play-stop-button").click()

    await expect.poll(() => rowState(human)).toBe("running")
    expect(await rowState(ai)).toBe("running")
    await expect.poll(() => aiRuns(page)).toEqual([{ taskPath: aiPath, status: "running" }])
    await expect
      .poll(() => readRunningTaskPaths(vaultDir).sort())
      .toEqual([aiPath, humanPath].sort())

    // × on the run's row in the AI Runs pane: stop and close.
    const runRow = page.locator(".ai-run-pane__run").filter({ hasText: "AI review" })
    await expect(runRow).toBeVisible()
    // The × takes pointer events only while its row is hovered.
    await runRow.hover()
    await runRow.locator(".ai-run-pane__run-close").click()

    await expect.poll(() => rowState(ai)).toBe("done")
    await expect.poll(() => rowState(human)).toBe("done")
    await expect.poll(() => aiRunLogStatuses(vaultDir)).toEqual({ [aiPath]: "stopped" })
    await expect.poll(() => readRunningTaskPaths(vaultDir)).toEqual([])
    expect(completedTaskPaths(vaultDir).sort()).toEqual([aiPath, humanPath].sort())
  })

  test("the AI process finishing on its own finishes both tasks", async ({ obsidian }, testInfo) => {
    const { vaultDir } = obsidian
    const { human, ai, humanPath, aiPath } = await setUp(obsidian, "finishes-on-its-own", testInfo.outputPath("bin"))

    await human.locator(".play-stop-button").click()
    await expect.poll(() => rowState(ai)).toBe("running")
    expect(await rowState(human)).toBe("running")

    // The fake CLI exits 0 after ~3 s; nothing else is clicked.
    await expect.poll(() => aiRunLogStatuses(vaultDir), { timeout: 15_000 }).toEqual({ [aiPath]: "succeeded" })
    await expect.poll(() => rowState(ai)).toBe("done")
    await expect.poll(() => rowState(human)).toBe("done")
    await expect.poll(() => readRunningTaskPaths(vaultDir)).toEqual([])
    expect(completedTaskPaths(vaultDir).sort()).toEqual([aiPath, humanPath].sort())
  })
})
