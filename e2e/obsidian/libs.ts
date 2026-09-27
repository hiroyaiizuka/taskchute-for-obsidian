import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { cacheRoot } from "./paths"

/**
 * Debian packages that provide the libraries Electron needs but a bare WSL or
 * server image usually lacks. Candidates are tried in order: Ubuntu 24.04+
 * renamed libasound2 to libasound2t64.
 */
const PACKAGES_BY_LIBRARY: Record<string, string[]> = {
  "libnspr4.so": ["libnspr4"],
  "libnss3.so": ["libnss3"],
  "libnssutil3.so": ["libnss3"],
  "libsmime3.so": ["libnss3"],
  "libasound.so.2": ["libasound2t64", "libasound2"],
}

function libDir(): string {
  return path.join(cacheRoot(), "libroot", "usr", "lib", "x86_64-linux-gnu")
}

function missingLibraries(executable: string, ldLibraryPath: string): string[] {
  const output = execFileSync("ldd", [executable], {
    encoding: "utf8",
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
  })
  return output
    .split("\n")
    .filter((line) => line.includes("=> not found"))
    .map((line) => line.trim().split(/\s+/)[0])
}

function download(pkg: string, into: string): boolean {
  try {
    execFileSync("apt-get", ["download", pkg], { cwd: into, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Makes every shared library the Obsidian executable links against
 * resolvable, without root: missing ones are fetched with `apt-get download`
 * and unpacked into the cache. Returns the LD_LIBRARY_PATH to launch with.
 */
export function ensureSharedLibraries(executable: string): string {
  const dir = libDir()
  let missing = missingLibraries(executable, dir)
  if (missing.length === 0) return dir

  const debs = path.join(cacheRoot(), "debs")
  fs.mkdirSync(debs, { recursive: true })
  const unknown: string[] = []
  const wanted = new Set<string[]>()
  for (const library of missing) {
    const candidates = PACKAGES_BY_LIBRARY[library]
    if (candidates) wanted.add(candidates)
    else unknown.push(library)
  }

  console.log(`[e2e] Fetching shared libraries: ${missing.join(", ")}`)
  for (const candidates of wanted) {
    candidates.some((pkg) => download(pkg, debs))
  }
  for (const deb of fs.readdirSync(debs).filter((f) => f.endsWith(".deb"))) {
    execFileSync("dpkg-deb", ["-x", path.join(debs, deb), path.join(cacheRoot(), "libroot")])
  }

  missing = missingLibraries(executable, dir)
  if (missing.length > 0) {
    throw new Error(
      `Obsidian cannot start: missing shared libraries ${missing.join(", ")}` +
        (unknown.length > 0 ? ` (no known package for ${unknown.join(", ")})` : "") +
        ". Install them system-wide, e.g. `sudo apt-get install libnss3 libasound2t64`.",
    )
  }
  return dir
}
