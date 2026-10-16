import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** A calm, newsreader-like Japanese voice; override with TASKCHUTE_RECORD_VOICE. */
export const DEFAULT_VOICE = "ja-JP-NanamiNeural"

export interface NarrationClip {
  file: string
  /** Seconds into the video at which the clip starts. */
  start: number
  duration: number
}

type Command = [executable: string, ...prefix: string[]]

// The edge-tts package installs a console script; where that is not on PATH
// (a venv that is not activated, some Windows installs) the module still runs.
const CANDIDATES: Command[] = [
  ["edge-tts"],
  ["python3", "-m", "edge_tts"],
  ["python", "-m", "edge_tts"],
  ["py", "-m", "edge_tts"],
]

async function findCommand(): Promise<Command | null> {
  for (const candidate of CANDIDATES) {
    const [executable, ...prefix] = candidate
    try {
      await run(executable, [...prefix, "--help"], { timeout: 15_000 })
      return candidate
    } catch {
      // Try the next spelling.
    }
  }
  return null
}

export async function mediaDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ])
  const seconds = Number(stdout.trim())
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${file}`)
  return seconds
}

/**
 * Reads captions aloud with edge-tts (free, no key; it sends the text to
 * Microsoft's Edge read-aloud service, so it needs a network connection).
 *
 * Narration is optional by design: without edge-tts, without a network, or
 * with TASKCHUTE_RECORD_TTS=off, every call returns null and the recording
 * carries captions only.
 */
export class Narrator {
  readonly voice = process.env.TASKCHUTE_RECORD_VOICE ?? DEFAULT_VOICE
  private command: Command | null | undefined
  private count = 0
  private warned = false

  constructor(private readonly dir: string) {}

  private warn(reason: string): void {
    if (this.warned) return
    this.warned = true
    console.warn(`[record] No narration, captions only: ${reason}`)
  }

  async synthesize(text: string): Promise<{ file: string; duration: number } | null> {
    if (process.env.TASKCHUTE_RECORD_TTS === "off") return null
    if (this.command === undefined) this.command = await findCommand()
    if (this.command === null) {
      this.warn("edge-tts is not installed (`pip install edge-tts`).")
      return null
    }

    fs.mkdirSync(this.dir, { recursive: true })
    this.count += 1
    const file = path.join(this.dir, `line-${String(this.count).padStart(2, "0")}.mp3`)
    const [executable, ...prefix] = this.command
    try {
      await run(
        executable,
        [...prefix, "--voice", this.voice, "--text", text, "--write-media", file],
        { timeout: 60_000 },
      )
      return { file, duration: await mediaDuration(file) }
    } catch (error) {
      this.warn(`edge-tts failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`)
      return null
    }
  }
}

/** What to read for a caption when the scenario gives no wording of its own. */
export function captionToSpeech(title: string, sub: string): string {
  // Circled numbers and other list markers read badly; "×" is read as "kakeru".
  const clean = (text: string) =>
    text
      .replace(/^[①-⑳\d.\s]+/u, "")
      .replace(/×/gu, "バツ")
      .replace(/[（(][^）)]*[）)]/gu, "")
      .trim()
  return [clean(title), clean(sub)].filter(Boolean).join("。")
}
