import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, createLinkedPair, enableAiTasks, openTaskChute, writeFakeClaude, skipOnWindows } from "../helpers/aiTask"
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
// Its Windows terminals ran without a broker, so there is none to retire there.
const OLD_RELEASE_HAD_NO_WINDOWS_BROKER = `${OLD_RELEASE} ran no broker on Windows`

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
    __lev391Held?: boolean
    __lev391Release?: () => void
    __lev391Start?: Promise<string>
    __lev391Outcome?: string
    __lev391BeforeReload?: boolean
    __lev391ReloadRequested?: boolean
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

/** Each test's vault path is the same on every run; drop a descriptor a failed run left. */
function forgetLeftoverDescriptor(vault: string): void {
  fs.rmSync(descriptorPath(vault), { force: true })
}

function readDescriptor(vault: string): Descriptor | null {
  try {
    return JSON.parse(fs.readFileSync(descriptorPath(vault), "utf8")) as Descriptor
  } catch {
    return null
  }
}

interface Impostor {
  port: number
  received: () => string
  connections: () => number
  close: () => Promise<void>
}

/** A local server that records every byte anyone sends it. */
async function startImpostor(port = 0): Promise<Impostor> {
  let received = ""
  let connections = 0
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.on("data", (chunk) => {
      received += chunk.toString()
    })
    socket.on("error", () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    received: () => received,
    connections: () => connections,
    // Drop open connections first, or close() waits for the peer to hang up.
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * Whether the process runs. A zombie counts as gone: a broker killed after a
 * window reload stays one, because the reload dropped the handle that would
 * have reaped it.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z")
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
  forgetLeftoverDescriptor(vault)
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

/**
 * Turn the stubbed license on or off and tell the plugin, as enableAiTasks
 * does, without waiting for the AI runtime to appear: the window may reload
 * under it, or the runtime may not start at all.
 */
async function setLicense(page: Page, claude: string, active: boolean): Promise<void> {
  await page.evaluate(
    ([id, claudePath, on]) => {
      const plugin = window.app.plugins.plugins[id] as {
        settings: Record<string, unknown>
        licenseManager: { isActive: () => boolean; state: unknown; listeners: Set<(state: unknown) => void> }
      }
      plugin.settings.aiTaskEnabled = true
      plugin.settings.aiTaskRunMode = "terminal"
      plugin.settings.aiTaskClaudePath = claudePath
      const state = { status: on ? "active" : "inactive" }
      plugin.licenseManager.state = state
      plugin.licenseManager.isActive = () => on
      for (const listener of plugin.licenseManager.listeners) listener(state)
    },
    [PLUGIN_ID, claude, active] as const,
  )
}

/** The managers the plugin still has to shut down (settings OFF or license loss). */
async function pendingDisposals(page: Page): Promise<number> {
  return page.evaluate(
    (id) => (window.app.plugins.plugins[id] as { aiTaskManagersPendingDisposal?: Set<unknown> }).aiTaskManagersPendingDisposal?.size ?? 0,
    PLUGIN_ID,
  )
}

/**
 * Update to this build and turn AI tasks on before the old runtime's grace
 * period ends. Finding the old release's runtime, this build lets it go and
 * reloads the window once. `reload: "stub"` records that request instead of
 * reloading, so a test can watch what the old release's code does meanwhile.
 */
async function updateToThisBuild(
  page: Page,
  vaultDir: string,
  claude: string,
  reload: "real" | "stub" = "real",
): Promise<void> {
  const thisBuild = path.join(process.env.TASKCHUTE_E2E_PLUGIN_DIR ?? path.resolve(__dirname, "../.."), "main.js")
  if (reload === "stub") {
    await page.evaluate(() => {
      const commands = window.app.commands as unknown as { executeCommandById(id: string): unknown }
      const original = commands.executeCommandById.bind(commands)
      commands.executeCommandById = (id) => {
        if (id !== "app:reload") return original(id)
        window.__lev391ReloadRequested = true
        return true
      }
    })
    await installAndReload(page, vaultDir, thisBuild)
    await enableAiTasks(page, claude, "terminal")
    await openTaskChute(page)
    await expect.poll(() => page.evaluate(() => window.__lev391ReloadRequested === true)).toBe(true)
    return
  }
  await page.evaluate(() => {
    window.__lev391BeforeReload = true
  })
  // This build lets the old runtime go as it loads and reloads the window,
  // which may cut these calls off. Wait for the reload either way.
  await installAndReload(page, vaultDir, thisBuild).catch(() => undefined)
  await expect
    .poll(() => page.evaluate(() => window.__lev391BeforeReload === true).catch(() => true), { timeout: 30_000 })
    .toBe(false)
  await page.waitForFunction(
    (id) => Boolean(window.app?.workspace?.layoutReady && window.app.plugins?.plugins?.[id]),
    PLUGIN_ID,
    { timeout: 30_000 },
  )
  // A new window: the license stub and settings are set again.
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
  skipOnWindows(OLD_RELEASE_HAD_NO_WINDOWS_BROKER)
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { vault, old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let fresh: Descriptor | null = null
  try {
    await updateToThisBuild(page, vaultDir, claude)

    // The window was reloaded, so none of the old release's code runs, and
    // this build runs its own manager.
    const protocol = await page.evaluate((id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      return manager.terminalBrokerProtocol
    }, PLUGIN_ID)
    expect(protocol).toBe(2)

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
  skipOnWindows(OLD_RELEASE_HAD_NO_WINDOWS_BROKER)
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { vault, old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let impostor: Impostor | null = null
  let fresh: Descriptor | null = null
  try {
    // A hot reload within the old release first. Its manager is adopted with
    // a new broker client, while the terminal's handle keeps the first one,
    // out of this build's reach.
    await installAndReload(page, vaultDir, await releasedMainJs(OLD_RELEASE))
    await enableAiTasks(page, claude, "terminal")
    await openTaskChute(page)
    expect(
      await page.evaluate(
        (id) => (window.app.plugins.plugins[id] as { aiTaskManager: unknown }).aiTaskManager === window.__lev391OldManager,
        PLUGIN_ID,
      ),
    ).toBe(true)

    await updateToThisBuild(page, vaultDir, claude)

    // The old broker dies and another process takes its port. Had any old
    // client survived the update, it would reconnect here and send the token.
    process.kill(old.pid, "SIGKILL")
    await expect.poll(() => isAlive(old.pid)).toBe(false)
    impostor = await startImpostor(old.port)

    // Use the plugin after the takeover: open a terminal and type into it.
    await startShell(page, "AFTER")
    fresh = readDescriptor(vault)
    expect(fresh?.version).toBe(2)
    expect(fresh?.port).not.toBe(old.port)
    // Give any reconnect loop time to fire.
    await page.waitForTimeout(3_000)

    expect(impostor.received()).toBe("")
    expect(impostor.connections()).toBe(0)
  } finally {
    await impostor?.close()
    await shutDown(page, [old.pid, ...(fresh ? [fresh.pid] : [])])
  }
})

test(`an AI task ${OLD_RELEASE} was starting when the update landed never dispatches through the old client`, async ({ obsidian, home }, testInfo) => {
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".zprofile"]) {
    fs.writeFileSync(path.join(home!, rc), "PS1='$ '\n")
  }
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  forgetLeftoverDescriptor(vault)
  await installAndReload(page, vaultDir, await releasedMainJs(OLD_RELEASE))
  await enableAiTasks(page, claude, "terminal")
  const { aiPath } = await createLinkedPair(page)
  await openTaskChute(page)

  // Start the AI task on the old release, and hold its first await (reading
  // the note) so the start is still in flight when the update lands.
  await page.evaluate(
    ([id, notePath]) => {
      const vault = window.app.vault as unknown as {
        cachedRead(file: { path: string }): Promise<string>
        getAbstractFileByPath(path: string): unknown
      }
      const original = vault.cachedRead.bind(vault)
      vault.cachedRead = (file) => {
        if (file.path !== notePath || window.__lev391Held) return original(file)
        window.__lev391Held = true
        vault.cachedRead = original
        return new Promise((resolve) => {
          window.__lev391Release = () => resolve(original(file))
        })
      }
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: { startRun(file: unknown): Promise<unknown> } })
        .aiTaskManager
      window.__lev391Start = manager.startRun(vault.getAbstractFileByPath(notePath)).then(
        () => "started",
        (error: Error) => `failed: ${error.message}`,
      )
    },
    [PLUGIN_ID, aiPath] as const,
  )
  await page.waitForFunction(() => window.__lev391Held === true)

  let impostor: Impostor | null = null
  try {
    await updateToThisBuild(page, vaultDir, claude, "stub")

    // A descriptor from before the proof, left behind by a dead broker, now
    // points at another process's port.
    impostor = await startImpostor()
    fs.writeFileSync(
      descriptorPath(vault),
      JSON.stringify({ version: 1, port: impostor.port, token: "e".repeat(64), pid: process.pid }),
      { mode: 0o600 },
    )

    // The held start resumes after the update.
    await page.evaluate(() => {
      window.__lev391Release?.()
      void window.__lev391Start?.then((outcome) => {
        window.__lev391Outcome = outcome
      })
    })
    await page.waitForTimeout(3_000)

    expect(impostor.received()).toBe("")
    expect(impostor.connections()).toBe(0)
    // It stopped at its next check instead of dispatching.
    await expect
      .poll(() => page.evaluate(() => window.__lev391Outcome ?? null), { timeout: 10_000 })
      .toMatch(/^failed: .*disposed/i)
  } finally {
    await impostor?.close()
    const left = readDescriptor(vault)
    if (left && left.pid === process.pid) fs.rmSync(descriptorPath(vault), { force: true })
    await shutDown(page, left && left.pid !== process.pid ? [left.pid] : [])
  }
})

test(`a lease activation ${OLD_RELEASE} was retrying when the update landed never dials afterwards`, async ({ obsidian, home }, testInfo) => {
  skipOnWindows(OLD_RELEASE_HAD_NO_WINDOWS_BROKER)
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { vault, old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let impostor: Impostor | null = null
  let fresh: Descriptor | null = null
  try {
    // The old broker dies, and the old client starts activating a renderer
    // lease. Each attempt is refused, so it keeps retrying for ten seconds.
    process.kill(old.pid, "SIGKILL")
    await expect.poll(() => isAlive(old.pid)).toBe(false)
    await page.evaluate((id) => {
      const manager = (window.app.plugins.plugins[id] as {
        aiTaskManager: { deps: { terminal: { dispatcher: { broker: { setRendererLeaseToken(token: string): Promise<void> } } } } }
      }).aiTaskManager
      window.__lev391Start = manager.deps.terminal.dispatcher.broker
        .setRendererLeaseToken("lev391-retrying-lease")
        .then(
          () => "activated",
          (error: Error) => `failed: ${error.message}`,
        )
      void window.__lev391Start.then((outcome) => {
        window.__lev391Outcome = outcome
      })
    }, PLUGIN_ID)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.__lev391Outcome ?? null)).toBeNull()

    await updateToThisBuild(page, vaultDir, claude, "stub")
    fresh = readDescriptor(vault)

    // While the old retry loop is still within its window, a descriptor from
    // before the proof points at another process's port.
    impostor = await startImpostor()
    fs.writeFileSync(
      descriptorPath(vault),
      JSON.stringify({ version: 1, port: impostor.port, token: "e".repeat(64), pid: process.pid }),
      { mode: 0o600 },
    )
    // Outlast the retry window (ten seconds from the first attempt).
    await page.waitForTimeout(10_000)

    expect(impostor.received()).toBe("")
    expect(impostor.connections()).toBe(0)
  } finally {
    await impostor?.close()
    const left = readDescriptor(vault)
    if (left && left.pid === process.pid) fs.rmSync(descriptorPath(vault), { force: true })
    await shutDown(page, [old.pid, ...(fresh ? [fresh.pid] : []), ...(left && left.pid !== process.pid ? [left.pid] : [])])
  }
})

test(`a ${OLD_RELEASE} runtime whose shutdown failed is not retried after the update`, async ({ obsidian, home }, testInfo) => {
  skipOnWindows(OLD_RELEASE_HAD_NO_WINDOWS_BROKER)
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let impostor: Impostor | null = null
  try {
    // A hot reload within the old release first: the terminal's handle keeps
    // the first broker client, out of reach of anything this build can fence.
    await installAndReload(page, vaultDir, await releasedMainJs(OLD_RELEASE))
    await enableAiTasks(page, claude, "terminal")
    await openTaskChute(page)
    expect(
      await page.evaluate(
        (id) => (window.app.plugins.plugins[id] as { aiTaskManager: unknown }).aiTaskManager === window.__lev391OldManager,
        PLUGIN_ID,
      ),
    ).toBe(true)

    // The old release turns AI tasks off while its broker is frozen. The
    // shutdown cannot be confirmed, so the manager stays queued for a retry.
    process.kill(old.pid, "SIGSTOP")
    await setLicense(page, claude, false)
    expect(await pendingDisposals(page)).toBe(1)
    await page.waitForTimeout(10_000)
    expect(await pendingDisposals(page)).toBe(1)

    // The broker dies and another process takes its port.
    process.kill(old.pid, "SIGCONT")
    process.kill(old.pid, "SIGKILL")
    await expect.poll(() => isAlive(old.pid)).toBe(false)
    impostor = await startImpostor(old.port)

    // The update. This build drops the queued old runtime instead of
    // retrying it (that would send the token here, unproved) and reloads the
    // window once, even with AI tasks off, to end the client the handle kept.
    const thisBuild = path.join(process.env.TASKCHUTE_E2E_PLUGIN_DIR ?? path.resolve(__dirname, "../.."), "main.js")
    await page.evaluate(() => {
      window.__lev391BeforeReload = true
    })
    await installAndReload(page, vaultDir, thisBuild).catch(() => undefined)
    await expect
      .poll(() => page.evaluate(() => window.__lev391BeforeReload === true).catch(() => true), { timeout: 30_000 })
      .toBe(false)
    await page.waitForFunction(
      (id) => Boolean(window.app?.workspace?.layoutReady && window.app.plugins?.plugins?.[id]),
      PLUGIN_ID,
      { timeout: 30_000 },
    )
    expect(await pendingDisposals(page)).toBe(0)
    await setLicense(page, claude, true)
    await page.waitForFunction(
      (id) => !!(window.app.plugins.plugins[id] as { aiTaskManager?: unknown }).aiTaskManager,
      PLUGIN_ID,
      { timeout: 10_000 },
    )
    await page.waitForTimeout(3_000)

    expect(impostor.received()).toBe("")
    expect(impostor.connections()).toBe(0)
  } finally {
    await impostor?.close()
    await shutDown(page, [old.pid])
  }
})

test(`updating from ${OLD_RELEASE} into a vault where AI tasks do not start still retires the old runtime`, async ({ obsidian, home }, testInfo) => {
  skipOnWindows(OLD_RELEASE_HAD_NO_WINDOWS_BROKER)
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let impostor: Impostor | null = null
  try {
    // The update lands in a plugin without a license, so no AI runtime is
    // built and nothing takes the old one over. It must still be let go, and
    // the window reloaded, before its handoff timer or its client acts.
    const thisBuild = path.join(process.env.TASKCHUTE_E2E_PLUGIN_DIR ?? path.resolve(__dirname, "../.."), "main.js")
    await page.evaluate(() => {
      window.__lev391BeforeReload = true
    })
    await installAndReload(page, vaultDir, thisBuild).catch(() => undefined)

    // Meanwhile the old broker dies and another process takes its port.
    process.kill(old.pid, "SIGKILL")
    await expect.poll(() => isAlive(old.pid)).toBe(false)
    impostor = await startImpostor(old.port)

    await expect
      .poll(() => page.evaluate(() => window.__lev391BeforeReload === true).catch(() => true), { timeout: 30_000 })
      .toBe(false)
    await page.waitForFunction(
      (id) => Boolean(window.app?.workspace?.layoutReady && window.app.plugins?.plugins?.[id]),
      PLUGIN_ID,
      { timeout: 30_000 },
    )
    // Past the old runtime's ten-second handoff, whose dispose would have
    // sent its shutdown here.
    await page.waitForTimeout(12_000)

    expect(impostor.received()).toBe("")
    expect(impostor.connections()).toBe(0)
  } finally {
    await impostor?.close()
    await shutDown(page, [old.pid])
  }
})

test(`a ${OLD_RELEASE} runtime whose handoff expired while the plugin was off still ends with the update`, async ({ obsidian, home }, testInfo) => {
  skipOnWindows(OLD_RELEASE_HAD_NO_WINDOWS_BROKER)
  const { page, vaultDir } = obsidian
  const claude = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  const { old } = await runOldReleaseWithTerminal(page, vaultDir, home!, claude)
  let impostor: Impostor | null = null
  try {
    // A hot reload within the old release first: the terminal's handle keeps
    // the first broker client, out of reach of anything this build can fence.
    await installAndReload(page, vaultDir, await releasedMainJs(OLD_RELEASE))
    await enableAiTasks(page, claude, "terminal")
    await openTaskChute(page)

    // The plugin is turned off while the broker is frozen, for longer than
    // the old release's ten-second handoff. The old runtime disposes itself
    // and leaves both the runtime slot and the pending-disposal registry,
    // so nothing names it any more.
    process.kill(old.pid, "SIGSTOP")
    await page.evaluate(async (id) => {
      await (window.app.plugins as unknown as { disablePlugin(id: string): Promise<void> }).disablePlugin(id)
    }, PLUGIN_ID)
    await page.waitForTimeout(12_000)

    // This build is enabled. It cannot find the old runtime, but sees that
    // the old release ran in this window, and reloads it once.
    const thisBuild = path.join(process.env.TASKCHUTE_E2E_PLUGIN_DIR ?? path.resolve(__dirname, "../.."), "main.js")
    fs.copyFileSync(thisBuild, path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID, "main.js"))
    await page.evaluate(() => {
      window.__lev391BeforeReload = true
    })
    await page
      .evaluate(async (id) => {
        await (window.app.plugins as unknown as { enablePlugin(id: string): Promise<void> }).enablePlugin(id)
      }, PLUGIN_ID)
      .catch(() => undefined)

    // Meanwhile the old broker dies and another process takes its port.
    // Had the client the handle kept survived, it would reconnect here.
    process.kill(old.pid, "SIGCONT")
    process.kill(old.pid, "SIGKILL")
    await expect.poll(() => isAlive(old.pid)).toBe(false)
    impostor = await startImpostor(old.port)

    await expect
      .poll(() => page.evaluate(() => window.__lev391BeforeReload === true).catch(() => true), { timeout: 30_000 })
      .toBe(false)
    await page.waitForFunction(
      (id) => Boolean(window.app?.workspace?.layoutReady && window.app.plugins?.plugins?.[id]),
      PLUGIN_ID,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(5_000)

    expect(impostor.received()).toBe("")
    expect(impostor.connections()).toBe(0)
  } finally {
    await impostor?.close()
    await shutDown(page, [old.pid])
  }
})
