import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { type Browser, type Page, chromium } from "@playwright/test"
import { PLUGIN_ID, REPO_ROOT, pluginArtifactsDir } from "./paths"

export type ObsidianLanguage = "en" | "ja"

export interface LaunchOptions {
  /** Throwaway directory that receives the config dir and the vault. */
  workDir: string
  language: ObsidianLanguage
  obsidianExecutable: string
  ldLibraryPath: string
}

export interface ObsidianSession {
  page: Page
  vaultDir: string
  /** Console errors and uncaught page errors seen since the plugin loaded. */
  errors: string[]
  /** Every console line, for attaching to a failed test. */
  consoleLines: string[]
  close(): Promise<void>
}

// Fixed so the trust flag below can be keyed by it.
const VAULT_ID = "e2e0000000000001"
const VAULT_TEMPLATE = path.join(REPO_ROOT, "e2e", "fixtures", "vault")
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"]
const CONNECT_TIMEOUT_MS = 30_000
const READY_TIMEOUT_MS = 30_000
const PLUGIN_LOAD_TIMEOUT_MS = 5_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function prepareDirectories(workDir: string): { configDir: string; vaultDir: string } {
  const configDir = path.join(workDir, "config")
  const vaultDir = path.join(workDir, "vault")
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(configDir, { recursive: true })
  fs.cpSync(VAULT_TEMPLATE, vaultDir, { recursive: true })

  const pluginDir = path.join(vaultDir, ".obsidian", "plugins", PLUGIN_ID)
  fs.mkdirSync(pluginDir, { recursive: true })
  for (const file of PLUGIN_FILES) {
    const source = path.join(pluginArtifactsDir(), file)
    if (!fs.existsSync(source)) {
      throw new Error(`${source} is missing; run \`npm run build\` first.`)
    }
    fs.copyFileSync(source, path.join(pluginDir, file))
  }
  fs.writeFileSync(
    path.join(vaultDir, ".obsidian", "community-plugins.json"),
    JSON.stringify([PLUGIN_ID]),
  )

  // Opening a registered vault with open: true skips the vault picker, and
  // updateDisabled keeps Obsidian from swapping in a newer app.asar mid-run.
  fs.writeFileSync(
    path.join(configDir, "obsidian.json"),
    JSON.stringify({
      updateDisabled: true,
      vaults: { [VAULT_ID]: { path: vaultDir, ts: Date.now(), open: true } },
    }),
  )
  return { configDir, vaultDir }
}

// Kill the whole process group: Obsidian forks GPU and renderer helpers, and a
// survivor keeps the debugging port, so a later run would attach to it.
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") {
      // No process groups on Windows; taskkill /T takes the helpers with it.
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      process.kill(-child.pid, "SIGKILL")
    }
  } catch {
    // Already gone.
  }
}

// macOS reports /private/tmp for /tmp, and Windows paths differ in case.
function samePath(left: string, right: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const [a, b] = [real(left), real(right)]
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function connect(port: number): Promise<Browser> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(250)
    }
  }
}

async function findVaultWindow(browser: Browser, vaultDir: string): Promise<Page> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      const basePath = await page
        .evaluate(() => window.app?.vault?.adapter?.basePath ?? null)
        .catch(() => null)
      // Guard against attaching to some other Obsidian instance.
      if (basePath !== null && samePath(basePath, vaultDir)) return page
    }
    await sleep(250)
  }
  throw new Error(`No Obsidian window opened the vault at ${vaultDir}`)
}

/**
 * Starts Obsidian on a fresh config dir and vault with the built plugin
 * installed and trusted, in the requested language.
 *
 * Playwright's _electron.launch() cannot be used: Obsidian's Electron build
 * disables Node's --inspect, so the suite connects over the Chrome DevTools
 * protocol instead.
 */
export async function launchObsidian(options: LaunchOptions): Promise<ObsidianSession> {
  const { configDir, vaultDir } = prepareDirectories(options.workDir)
  const port = await freePort()

  const child = spawn(
    options.obsidianExecutable,
    ["--no-sandbox", `--user-data-dir=${configDir}`, `--remote-debugging-port=${port}`],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LD_LIBRARY_PATH: options.ldLibraryPath },
    },
  )
  const onExit = () => killGroup(child)
  process.once("exit", onExit)

  let browser: Browser | undefined
  const close = async () => {
    await browser?.close().catch(() => undefined)
    killGroup(child)
    process.removeListener("exit", onExit)
  }

  try {
    browser = await connect(port)
    const page = await findVaultWindow(browser, vaultDir)

    // Neither setting can be passed on the command line. Obsidian reads the
    // UI language from localStorage (getLanguage() returns it), and trusting
    // the vault is the enable-plugin-<vaultId> flag the "Trust author" button
    // sets. Both are read at load, hence the reload.
    await page.evaluate(
      ([vaultId, language]) => {
        localStorage.setItem(`enable-plugin-${vaultId}`, "true")
        localStorage.setItem("language", language)
      },
      [VAULT_ID, options.language] as const,
    )

    const errors: string[] = []
    const consoleLines: string[] = []
    page.on("console", (message) => {
      const line = `[${message.type()}] ${message.text()}`
      consoleLines.push(line)
      if (message.type() === "error") errors.push(line)
    })
    page.on("pageerror", (error) => {
      consoleLines.push(`[pageerror] ${error.stack ?? error.message}`)
      errors.push(`[pageerror] ${error.message}`)
    })

    await page.reload()
    await page.waitForFunction(() => window.app?.workspace?.layoutReady === true, undefined, {
      timeout: READY_TIMEOUT_MS,
    })
    // Community plugins load around layout-ready. One that throws while
    // loading never appears, so fail with the console output that says why
    // instead of a bare timeout.
    await page
      .waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, {
        timeout: PLUGIN_LOAD_TIMEOUT_MS,
      })
      .catch(() => {
        throw new Error(
          `${PLUGIN_ID} did not load. Console errors:\n${errors.join("\n") || "(none)"}`,
        )
      })

    return { page, vaultDir, errors, consoleLines, close }
  } catch (error) {
    await close()
    throw error
  }
}
