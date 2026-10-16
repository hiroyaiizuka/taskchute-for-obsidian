import fs from "node:fs"
import path from "node:path"
import type { CDPSession, Locator, Page } from "@playwright/test"
import { type Frame, encodeVideo } from "./encode"
import { type NarrationClip, Narrator, captionToSpeech } from "./narration"

export const VIDEO_WIDTH = 1280
export const VIDEO_HEIGHT = 800
/** The caption bar takes this much off the bottom of Obsidian's own layout. */
const CAPTION_HEIGHT = 78
/** Breathing room after a narration line before the next one starts. */
const NARRATION_GAP_S = 0.5
/** How long a caption stays up at the very least, read aloud or not. */
const MIN_CAPTION_S = 2.5
/** Reading speed for a caption nobody reads aloud (Japanese, unhurried). */
const READING_CHARS_PER_S = 9

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const OVERLAY_CSS = `
  #tc-rec-caption {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646; pointer-events: none;
    box-sizing: border-box; height: ${CAPTION_HEIGHT}px; padding: 12px 28px;
    background: rgba(17, 16, 21, .94); color: #fff; border-top: 2px solid #7f6df2;
    font: 600 19px/1.5 "Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK JP", system-ui, sans-serif;
  }
  #tc-rec-caption small {
    display: block; color: #cfcbe6;
    font: 400 14px/1.5 "Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK JP", system-ui, sans-serif;
  }
  #tc-rec-dot {
    position: fixed; left: var(--tc-rec-x, -50px); top: var(--tc-rec-y, -50px);
    z-index: 2147483647; pointer-events: none;
    width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
    background: rgba(239, 68, 68, .55); border: 2px solid #ef4444; transition: transform .12s;
  }
  #tc-rec-dot.is-down { transform: scale(.6); }
  /* Obsidian lays itself out above the caption bar instead of under it. */
  .app-container { height: calc(100% - ${CAPTION_HEIGHT}px) !important; }
`

export interface Chapter {
  /** Seconds into the video. */
  t: number
  title: string
  sub: string
}

export interface CaptionOptions {
  /** Second, smaller line. */
  sub?: string
  /**
   * What the narrator says. Defaults to the caption itself; pass wording of
   * your own where the caption reads badly aloud, or false for silence.
   */
  say?: string | false
}

export interface RecordingResult {
  video: string
  chapters: string
  duration: number
  narrated: boolean
}

/**
 * Records one Obsidian window as a captioned, optionally narrated video.
 *
 * The picture comes from the DevTools screencast of the window itself, so no
 * screen-recording permission is needed and other windows never get in the
 * way. A caption bar and a dot at the mouse position are drawn inside the page.
 *
 * Video time is wall-clock time minus the pauses taken while a narration line
 * is being synthesized, so the wait for the voice never shows up as dead air.
 */
export class Recorder {
  private readonly frames: Frame[] = []
  private readonly chapters: Chapter[] = []
  private readonly clips: NarrationClip[] = []
  private readonly narrator: Narrator
  private readonly framesDir: string
  private cdp: CDPSession | null = null
  private startedAt = 0
  private pausedAt: number | null = null
  private pausedTotal = 0
  /** Video time before which the current caption must stay up. */
  private holdUntil = 0
  private finished = false

  constructor(
    private readonly page: Page,
    private readonly outDir: string,
    private readonly name: string,
  ) {
    fs.rmSync(outDir, { recursive: true, force: true })
    this.framesDir = path.join(outDir, "frames")
    fs.mkdirSync(this.framesDir, { recursive: true })
    this.narrator = new Narrator(path.join(outDir, "narration"))
  }

  get started(): boolean {
    return this.cdp !== null
  }

  private now(): number {
    const wall = this.pausedAt ?? Date.now() / 1000
    return Math.max(0, wall - this.startedAt - this.pausedTotal)
  }

  /** Sizes the window, draws the overlay and starts the screencast. */
  async start(title: string, options: CaptionOptions = {}): Promise<void> {
    if (this.started) throw new Error("The recording has already started.")
    const { page } = this

    await page.evaluate(
      ([width, height]) => {
        const host = window as unknown as {
          electron?: {
            remote?: {
              getCurrentWindow?: () => {
                setContentSize?: (w: number, h: number) => void
                setSize?: (w: number, h: number) => void
              }
            }
          }
        }
        const win = host.electron?.remote?.getCurrentWindow?.()
        if (win?.setContentSize) win.setContentSize(width, height)
        else if (win?.setSize) win.setSize(width, height)
        else window.resizeTo(width, height)
      },
      [VIDEO_WIDTH, VIDEO_HEIGHT] as const,
    )
    await sleep(600)

    await page.addStyleTag({ content: OVERLAY_CSS })
    await page.evaluate(() => {
      const caption = document.createElement("div")
      caption.id = "tc-rec-caption"
      const dot = document.createElement("div")
      dot.id = "tc-rec-dot"
      document.body.append(caption, dot)
      window.addEventListener(
        "mousemove",
        (event) => {
          dot.style.setProperty("--tc-rec-x", `${event.clientX}px`)
          dot.style.setProperty("--tc-rec-y", `${event.clientY}px`)
        },
        true,
      )
      window.addEventListener("mousedown", () => dot.classList.add("is-down"), true)
      window.addEventListener("mouseup", () => dot.classList.remove("is-down"), true)
    })
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await page.mouse.move(size.width / 2, size.height / 2)

    // The opening caption is on screen, and its line ready, before frame zero.
    await this.writeCaption(title, options.sub ?? "")
    const opening = await this.voice(title, options)

    this.cdp = await page.context().newCDPSession(page)
    this.cdp.on("Page.screencastFrame", (frame) => {
      const cdp = this.cdp
      if (!cdp) return
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined)
      if (this.finished || this.pausedAt !== null) return
      const last = this.frames[this.frames.length - 1]
      const wall = frame.metadata.timestamp ?? Date.now() / 1000
      const t = Math.max(last?.t ?? 0, wall - this.startedAt - this.pausedTotal)
      const name = `f${String(this.frames.length).padStart(6, "0")}.jpg`
      fs.writeFileSync(path.join(this.framesDir, name), Buffer.from(frame.data, "base64"))
      this.frames.push({ name, t })
    })

    this.startedAt = Date.now() / 1000
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 90,
      maxWidth: size.width,
      maxHeight: size.height,
      everyNthFrame: 1,
    })
    // Nothing is sent until the picture changes; nudge it so frame zero exists.
    await page.mouse.move(size.width / 2 + 1, size.height / 2)
    this.chapters.push({ t: 0, title, sub: options.sub ?? "" })
    this.hold(opening, title + (options.sub ?? ""))
  }

  private async writeCaption(title: string, sub: string): Promise<void> {
    await this.page.evaluate(
      ([main, small]) => {
        const caption = document.getElementById("tc-rec-caption")
        if (!caption) return
        caption.textContent = main
        if (small) {
          const line = document.createElement("small")
          line.textContent = small
          caption.append(line)
        }
      },
      [title, sub] as const,
    )
  }

  /** Synthesizes the line with the clock stopped. */
  private async voice(
    title: string,
    options: CaptionOptions,
  ): Promise<{ file: string; duration: number } | null> {
    if (options.say === false) return null
    const text = options.say ?? captionToSpeech(title, options.sub ?? "")
    if (!text) return null
    const resume = this.started && this.pausedAt === null
    if (resume) this.pausedAt = Date.now() / 1000
    try {
      return await this.narrator.synthesize(text)
    } finally {
      if (resume && this.pausedAt !== null) {
        this.pausedTotal += Date.now() / 1000 - this.pausedAt
        this.pausedAt = null
      }
    }
  }

  private hold(clip: { file: string; duration: number } | null, text: string): void {
    const start = this.now()
    if (clip) this.clips.push({ file: clip.file, start, duration: clip.duration })
    // Narrated: until the line has been said. Silent: long enough to read it.
    const needed = clip ? clip.duration + NARRATION_GAP_S : text.length / READING_CHARS_PER_S
    this.holdUntil = start + Math.max(MIN_CAPTION_S, needed)
  }

  /** Waits until the current caption has been up (and read) long enough. */
  async settle(): Promise<void> {
    const remaining = this.holdUntil - this.now()
    if (remaining > 0) await sleep(remaining * 1000)
  }

  /** Changes the caption without starting a new chapter. */
  async caption(title: string, options: CaptionOptions = {}): Promise<void> {
    this.assertRunning()
    await this.settle()
    const clip = await this.voice(title, options)
    await this.writeCaption(title, options.sub ?? "")
    this.hold(clip, title + (options.sub ?? ""))
  }

  /** Starts a new scene: a caption that is also an entry in the chapter list. */
  async chapter(title: string, options: CaptionOptions = {}): Promise<void> {
    this.assertRunning()
    await this.settle()
    const clip = await this.voice(title, options)
    await this.writeCaption(title, options.sub ?? "")
    this.chapters.push({ t: this.now(), title, sub: options.sub ?? "" })
    this.hold(clip, title + (options.sub ?? ""))
  }

  /** Moves the mouse to the middle of `target` the way a hand would. */
  async hover(target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded().catch(() => undefined)
    const box = await target.boundingBox()
    if (!box) throw new Error("Cannot point at an element that is not on screen.")
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 })
    await sleep(350)
  }

  /** Points at `target`, then clicks it, slowly enough to follow. */
  async click(target: Locator): Promise<void> {
    await this.hover(target)
    await this.page.mouse.down()
    await sleep(90)
    await this.page.mouse.up()
    await sleep(250)
  }

  /** Lets the viewer look at the result for a moment. */
  async pause(ms: number): Promise<void> {
    await sleep(ms)
  }

  private assertRunning(): void {
    if (!this.started) throw new Error("Call start() before the first chapter.")
    if (this.finished) throw new Error("The recording has already finished.")
  }

  /** Stops the screencast and writes <name>.mp4 and chapters.json. */
  async finish(): Promise<RecordingResult> {
    this.assertRunning()
    await this.settle()
    await sleep(600)
    const end = this.now()
    this.finished = true
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined)

    const video = path.join(this.outDir, `${this.name}.mp4`)
    await encodeVideo({
      framesDir: this.framesDir,
      frames: this.frames,
      end,
      clips: this.clips,
      output: video,
    })
    const chapters = path.join(this.outDir, "chapters.json")
    fs.writeFileSync(
      chapters,
      JSON.stringify(
        {
          video: path.basename(video),
          duration: Number(end.toFixed(1)),
          narrated: this.clips.length > 0,
          voice: this.clips.length > 0 ? this.narrator.voice : null,
          chapters: this.chapters.map((c) => ({ ...c, t: Number(c.t.toFixed(1)) })),
        },
        null,
        2,
      ),
    )
    return { video, chapters, duration: end, narrated: this.clips.length > 0 }
  }
}
