import { execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import type { NarrationClip } from "./narration"

const run = promisify(execFile)

export interface Frame {
  /** File name inside the frames directory. */
  name: string
  /** Seconds into the video. */
  t: number
}

export function assertFfmpeg(): void {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" })
  } catch {
    throw new Error(
      "ffmpeg and ffprobe are needed to record. " +
        "macOS: `brew install ffmpeg`; Windows: `winget install Gyan.FFmpeg`; Linux: `apt install ffmpeg`.",
    )
  }
}

/**
 * Turns the screencast frames into an mp4, with the narration clips mixed in
 * at their start times.
 *
 * The screencast only sends a frame when the picture changes, so each frame is
 * held until the next one; the concat demuxer does that from the timestamps.
 */
export async function encodeVideo(options: {
  framesDir: string
  frames: Frame[]
  /** Length of the video in seconds; the last frame is held until then. */
  end: number
  clips: NarrationClip[]
  output: string
}): Promise<void> {
  const { framesDir, frames, end, clips, output } = options
  if (frames.length === 0) throw new Error("Nothing was recorded: the screencast sent no frames.")

  const lines = ["ffconcat version 1.0"]
  frames.forEach((frame, index) => {
    const next = index + 1 < frames.length ? frames[index + 1].t : Math.max(end, frame.t + 0.1)
    lines.push(`file '${frame.name}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(4)}`)
  })
  // The demuxer ignores the last duration unless the file is listed again.
  lines.push(`file '${frames[frames.length - 1].name}'`)
  const list = path.join(framesDir, "frames.ffconcat")
  fs.writeFileSync(list, lines.join("\n"))

  const inputs = ["-f", "concat", "-safe", "0", "-i", list]
  for (const clip of clips) inputs.push("-i", clip.file)

  // yuv420p and even dimensions: what browsers and QuickTime both play.
  const graph = ["[0:v]fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p[v]"]
  const maps = ["-map", "[v]"]
  if (clips.length > 0) {
    clips.forEach((clip, index) => {
      const ms = Math.round(clip.start * 1000)
      graph.push(`[${index + 1}:a]adelay=${ms}:all=1[a${index}]`)
    })
    const mixed = clips.map((_, index) => `[a${index}]`).join("")
    graph.push(`${mixed}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[a]`)
    maps.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k")
  }

  fs.mkdirSync(path.dirname(output), { recursive: true })
  await run(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      ...inputs,
      "-filter_complex", graph.join(";"),
      ...maps,
      "-c:v", "libx264", "-preset", "slow", "-crf", "23",
      "-t", end.toFixed(3),
      "-movflags", "+faststart",
      output,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  )
}
