import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute, writeFakeClaude } from "../helpers/aiTask"
import { cacheRoot } from "../obsidian/paths"

// LEV-391: updating from a release whose broker cannot prove itself.
//
// Obsidian updates a plugin in place: it disables the old version and enables
// the new one in the same window. The new version may find the old version's
// AI runtime still alive and take it over (hot reload). That runtime's code
// dials the broker without asking it to prove itself, so taking it over would
// keep that code running after the update. These tests start on the released
// 3.0.1 bundle with a live AI terminal, update to this build, and check that
// nothing from the old version keeps talking to a broker.

const OLD_RELEASE = "3.0.1"

test.use({ isolatedHome: true })

interface ManagerHandle {
  terminalBrokerProtocol?: number
  startShellSession(options: { name?: string; cols?: number; rows?: number }): { id: string }
  onTerminalData(runId: string, listener: (chunk: string) => void): () => void
  sendTerminalInput(runId: string, data: string): void
  getRun(runId: string): { status: string } | undefined
  disposeAndWait(): Promise<void>
}

interface Descriptor {
  version: number
  port: number
  pid: number
}

declare global {
  interface Window {
    __lev391Output?: Record<string, string>
    __lev391OldManager?: unknown
  }
}

/** The main.js users of OLD_RELEASE have installed, downloaded once and cached. */
async function releasedMainJs(version: string): Promise<string> {
  const file = path.join(cacheRoot(), "releases", version, "main.js")
  if (fs.existsSync(file)) return file
  const url = `https://github.com/hiroyaiizuka/taskchute-for-obsidian/releases/download/${version}/main.js`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.part`, Buffer.from(await response.arrayBuffer()))
  fs.renameSync(`${file}.part`, file)
  return file
}

/** Replace the installed main.js and load the plugin again, as an update does. */
async function installAndReload(page: Page, vaultDir: string, mainJs: string): Promise<void> {
  fs.copyFileSync(mainJs, path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID, "main.js"))
  await page.evaluate(async (id) => {
    const plugins = window.app.plugins as unknown as {
      disablePlugin(id: string): Promise<void>
      enablePlugin(id: string): Promise<void>
    }
    await plugins.disablePlugin(id)
    await plugins.enablePlugin(id)
  }, PLUGIN_ID)
  await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]), PLUGIN_ID)
}

function descriptorPath(vault: string): string {
  const hash = crypto.createHash("sha256").update(`taskchute-plus:${vault}`).digest("hex").slice(0, 24)
  return path.join(os.tmpdir(), `taskchute-plus-ai-broker-${hash}.json`)
}

function readDescriptor(vault: string): Descriptor | null {
  try {
    return JSON.parse(fs.readFileSync(descriptorPath(vault), "utf8")) as Descriptor
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** TCP connections from anyone on this machine to 127.0.0.1:port. */
function connectionsTo(port: number): number {
  const out = execFileSync("ss", ["-Htn", "state", "established", `( dport = :${port} )`], { encoding: "utf8" })
  return out.split("\n").filter((line) => line.trim().length > 0).length
}

async function startShell(page: Page, marker: string): Promise<string> {
  const runId = await page.evaluate((id) => {
    const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
    return manager.startShellSession({ name: "Terminal", cols: 80, rows: 24 }).id
  }, PLUGIN_ID)
  await page.evaluate(
    ([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      window.__lev391Output ??= {}
      window.__lev391Output[run] = ""
      manager.onTerminalData(run, (chunk) => {
        window.__lev391Output![run] += chunk
      })
    },
    [PLUGIN_ID, runId] as const,
  )
  // The prompt may not be up yet; send until the shell answers.
  await expect
    .poll(
      async () => {
        await page.evaluate(
          ([id, run, text]) => {
            const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
            manager.sendTerminalInput(run, `echo ${text}_$((40+2))\r`)
          },
          [PLUGIN_ID, runId, marker] as const,
        )
        return page.evaluate((run) => window.__lev391Output?.[run] ?? "", runId)
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toContain(`${marker}_42`)
  return runId
}

/** Start on OLD_RELEASE with a live terminal, as a user about to update would be. */
async function runOldReleaseWithTerminal(
  page: Page,
  vaultDir: string,
  home: string,
  claude: string,
): Promise<{ vault: string; old: Descriptor }> {
  for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".zprofile"]) {
    fs.writeFileSync(path.join(home, rc), "PS1='$ '\n")
  }
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  await installAndReload(page, vaultDir, await releasedMainJs(OLD_RELEASE))
  await enableAiTasks(page, claude, "terminal")
  await openTaskChute(page)
  await startShell(page, "OLD")

  const old = readDescriptor(vault)
  // The released broker writes the descriptor format from before the proof.
  expect(old?.version).toBe(1)
  expect(isAlive(old!.pid)).toBe(true)
  expect(connectionsTo(old!.port)).toBeGreaterThan(0)
  await page.evaluate((id) => {
    window.__lev391OldManager = (window.app.plugins.plugins[id] as { aiTaskManager: unknown }).aiTaskManager
  }, PLUGIN_ID)
  return { vault, old: old! }
}

/** Update to this build and turn AI tasks on before the old runtime's grace period ends. */
async function updateToThisBuild(page: Page, vaultDir: string, claude: string): Promise<void> {
  await installAndReload(page, vaultDir, path.join(process.env.TASKCHUTE_E2E_PLUGIN_DIR ?? path.resolve(__dirname, "../.."), "main.js"))
  await enableAiTasks(page, claude, "terminal")
  await openTaskChute(page)
}

async function shutDown(page: Page, pids: number[]): Promise<void> {
  // Brokers outlive the Obsidian process group the fixture kills.
  await page
    .evaluate(async (id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
      await manager?.disposeAndWait()
    }, PLUGIN_ID)
    .catch(() => undefined)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}

test(`updating from ${OLD_RELEASE} with a live terminal moves to a new broker without trusting the old one`, async ({ obsidian, home }, testInfo) => {
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { vault, old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let fresh: Descriptor | null = null
  try {
    await updateToThisBuild(page, vaultDir, claude)

    // The old runtime was not taken over: this build runs its own manager.
    const adoption = await page.evaluate((id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      return { protocol: manager.terminalBrokerProtocol, same: manager === window.__lev391OldManager }
    }, PLUGIN_ID)
    expect(adoption).toEqual({ protocol: 2, same: false })

    // A terminal opened after the update runs on a fresh broker that proves itself.
    await startShell(page, "NEW")
    fresh = readDescriptor(vault)
    expect(fresh?.version).toBe(2)
    expect(fresh?.pid).not.toBe(old.pid)

    // Nothing in Obsidian is connected to the old broker any more, and it was
    // not signalled: it stops itself, and its sessions, after its idle TTL.
    await expect.poll(() => connectionsTo(old.port), { timeout: 10_000 }).toBe(0)
    expect(isAlive(old.pid)).toBe(true)
  } finally {
    await shutDown(page, [old.pid, ...(fresh ? [fresh.pid] : [])])
  }
})

test(`after updating from ${OLD_RELEASE}, a process that takes the old broker's port gets nothing`, async ({ obsidian, home }, testInfo) => {
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { vault, old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let impostor: net.Server | null = null
  let fresh: Descriptor | null = null
  try {
    await updateToThisBuild(page, vaultDir, claude)

    // The old broker dies and another process takes its port. Had the old
    // runtime been kept, its client would reconnect here and send the token.
    process.kill(old.pid, "SIGKILL")
    await expect.poll(() => isAlive(old.pid)).toBe(false)
    let received = ""
    let connections = 0
    impostor = net.createServer((socket) => {
      connections += 1
      socket.on("data", (chunk) => {
        received += chunk.toString()
      })
      socket.on("error", () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      impostor!.once("error", reject)
      impostor!.listen(old.port, "127.0.0.1", () => resolve())
    })

    // Use the plugin after the takeover: open a terminal and type into it.
    await startShell(page, "AFTER")
    fresh = readDescriptor(vault)
    expect(fresh?.version).toBe(2)
    expect(fresh?.port).not.toBe(old.port)
    // Give any reconnect loop time to fire.
    await page.waitForTimeout(3_000)

    expect(received).toBe("")
    expect(connections).toBe(0)
  } finally {
    await new Promise((resolve) => (impostor ? impostor.close(resolve) : resolve(undefined)))
    await shutDown(page, [old.pid, ...(fresh ? [fresh.pid] : [])])
  }
})
