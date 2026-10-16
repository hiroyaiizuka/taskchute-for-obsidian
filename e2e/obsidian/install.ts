import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import { OBSIDIAN_VERSION, cacheRoot } from "./paths"

/**
 * Returns the path of an extracted Obsidian executable, downloading the
 * pinned AppImage on first use. The AppImage is extracted rather than run so
 * FUSE is not required.
 */
export async function ensureObsidian(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `The E2E suite supports Linux x64 only for now (got ${process.platform}/${process.arch}).`,
    )
  }

  const dir = path.join(cacheRoot(), `obsidian-${OBSIDIAN_VERSION}`)
  const executable = path.join(dir, "squashfs-root", "obsidian")
  if (fs.existsSync(executable)) return executable

  fs.mkdirSync(dir, { recursive: true })
  const appImage = path.join(dir, `Obsidian-${OBSIDIAN_VERSION}.AppImage`)
  const url = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION}.AppImage`

  console.log(`[e2e] Downloading Obsidian ${OBSIDIAN_VERSION}…`)
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }
  const partial = `${appImage}.part`
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    fs.createWriteStream(partial),
  )
  fs.renameSync(partial, appImage)
  fs.chmodSync(appImage, 0o755)

  console.log("[e2e] Extracting the AppImage…")
  fs.rmSync(path.join(dir, "squashfs-root"), { recursive: true, force: true })
  execFileSync(appImage, ["--appimage-extract"], { cwd: dir, stdio: "ignore" })
  fs.rmSync(appImage)

  if (!fs.existsSync(executable)) {
    throw new Error(`Extraction did not produce ${executable}`)
  }
  return executable
}
