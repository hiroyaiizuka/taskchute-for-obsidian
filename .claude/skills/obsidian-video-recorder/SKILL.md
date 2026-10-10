---
name: obsidian-video-recorder
description: Record a captioned, narrated walkthrough of TaskChute Plus running in a real Obsidian with `npm run record:video`, and publish it as a page with a seekable chapter list. Use when asked for a video of a feature or a fix ("動画を撮って", "録画して", "動作確認の動画"), for before/after comparisons, and when an issue should carry visual proof that something works.
---

# Obsidian video recorder

`npm run record:video` builds the plugin, starts a real Obsidian on a throwaway
vault, plays a scripted scenario at reading speed, and writes an mp4 with a
caption bar, a dot at the mouse position and a read-aloud narration. The tools
live in `e2e/recording/`; they reuse the E2E suite's launcher and helpers.

## What a recording is for

A recording is evidence, written for someone who was not there. That decides
most of what follows.

- **Show the issue's own list.** Take the operations from the issue's
  acceptance criteria or its "after the fix" table and play them in that
  order, one scene each. Do not invent a tour.
- **Check every scene.** After each operation the scenario asserts the state
  the caption claims (`expect.poll(...)`). A scenario that does not reach the
  state fails and writes no video. Never record a state the app did not reach.
- **One video, under two minutes.** Split into several only for a before/after
  comparison, where both are recorded with the same script.
- **Say what was faked.** A fake CLI, a stubbed licence, a workaround: each is
  named in the opening caption or on the page. So is anything the video does
  *not* cover.
- **Captions carry the content; the voice follows them.** The video must make
  sense muted. Narration is optional and falls back to captions only.
- **Japanese by default.** Obsidian's UI, task names, captions and narration
  are Japanese (`test.use({ language: "en" })` for English).

## Run

```bash
npm run record:video -- -g "ai-link-sync"             # one scenario, by its title
npm run record:video                                  # every scenario
TASKCHUTE_E2E_SKIP_BUILD=1 npm run record:video -- -g "…"   # reuse the current main.js
TASKCHUTE_RECORD_TTS=off npm run record:video -- -g "…"     # captions only
```

Output, per scenario, in `e2e-results/recordings/<title>/` (gitignored):

- `<title>.mp4` – 1280×800, 30 fps, H.264 + AAC.
- `chapters.json` – duration, whether it is narrated, and each chapter's start
  time, title and sub-line. The page's chapter list is written from this.
- `frames/`, `narration/` – working files; safe to delete.

An Obsidian window opens for the length of the scenario. It can sit behind
other windows; the picture is taken from the window itself, not the screen.

## Requirements

| | macOS | Windows | Linux x64 / WSL |
|---|---|---|---|
| Obsidian | the installed app | the installed app | pinned AppImage, downloaded on first run |
| ffmpeg + ffprobe | `brew install ffmpeg` | `winget install Gyan.FFmpeg` | `apt install ffmpeg` |
| Narration | `pip install edge-tts` | `pip install edge-tts` | `pip install edge-tts` |
| Display | – | – | WSLg / desktop, or `xvfb-run -a` |

- `TASKCHUTE_E2E_OBSIDIAN_PATH` points at another Obsidian executable.
- On macOS and Windows the Obsidian version is whatever is installed; put the
  version on the page.
- **Narration** uses [edge-tts](https://github.com/rany2/edge-tts): free, no
  key. It sends the caption text to Microsoft's Edge read-aloud service, so it
  needs a network connection, and it is not an official public API — fine for
  internal walkthroughs, not something to build a public campaign on. The
  voice is `ja-JP-NanamiNeural`; `TASKCHUTE_RECORD_VOICE` changes it
  (`edge-tts --list-voices`). Without edge-tts or a network the run prints one
  warning and records captions only.
- **Fake AI CLI** (`writeSwitchableFakeClaude`) is a POSIX shell script: macOS,
  Linux and WSL. On native Windows record AI scenes with the real CLI.
- Native Windows has not been run yet (as of 2026-10-10); macOS and the Linux
  path it shares with the E2E suite have. Expect to fix small things there.

## Writing a scenario

A scenario is a Playwright test in `e2e/recording/scenarios/*.spec.ts`. Its
title is the output name. `ai-link-sync.spec.ts` is the worked example.

```ts
import { expect, test } from "../fixtures"

test("my-feature", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  // 1. Set up off camera: settings, notes (createNotes), open the view.
  // 2. Start: the opening caption is chapter 0.
  await recorder.start("最初の状態を一文で", { sub: "偽物を使うならここで言う" })
  // 3. One chapter per operation, each ending on a check.
  await recorder.chapter("① 何をするか", { sub: "どうなるか" })
  await recorder.click(page.locator(".some-button"))
  await expect.poll(() => readState(page)).toBe("expected")
  // The video is encoded when the test passes.
})
```

- `recorder.start(title, { sub, say })` – sizes the window to 1280×800, draws
  the overlay, starts recording.
- `recorder.chapter(title, { sub, say })` – new scene and chapter-list entry.
  `recorder.caption(...)` changes the caption inside a scene.
- `recorder.click(locator)` / `recorder.hover(locator)` – move the mouse there
  visibly, then act. Use these instead of `locator.click()` for anything the
  viewer should see; plain Playwright calls are fine for setup.
- `recorder.pause(ms)` – a moment to look. Rarely needed: each caption already
  stays up until its narration has finished, or, without narration, for as
  long as it takes to read (at least 2.5 s).
- `say` – the narrator reads the caption by default (list markers and
  parentheses dropped, "×" read as "バツ"). Pass wording of its own when the
  caption is terse, or `false` for silence.
- Notes go in with `createNotes(page, { "TaskChute/Task/名前.md": "…" })`. It
  first re-indexes the vault: on macOS a fresh vault leaves the `TaskChute`
  folder out of Obsidian's file tree, and notes created under it never show up.
- Reuse `e2e/helpers/aiTask.ts` (`enableAiTasks`, `taskRow`, `rowState`,
  `openTaskChute`) rather than new selectors.
- **AI runs are recorded in the terminal**, because that is the plugin's
  default and what users see: `enableAiTasks(page, cliPath, "terminal")`. The
  E2E helper's own default is conversation mode (headless), which shows an
  "イベント" tab instead of "ターミナル" — do not record that by accident.
  - After starting a run, `waitForTerminalOutput(page, taskPath, text)` waits
    until the CLI has printed something; the login shell takes a moment and a
    short scene would otherwise show a blank terminal.
  - A terminal run does not end when its CLI exits: the session falls back to
    the login shell and stays "running". Only a conversation-mode run ends by
    itself. Leave a scene about "the AI process finishing on its own" out of
    a terminal recording and list it under what the video does not cover;
    do not quietly switch one scene to conversation mode.
  - That login shell is the real one of whoever records. If the CLI exits on
    camera, their prompt (user name, host, folder) is in the video.
- Captions: a numbered title that says the operation ("② 人間タスクを停止する"),
  a sub-line that says the result ("両方とも完了になる"). One sentence each.

## Before and after

Record the same scenario twice: once on the commit before the fix, once after.

```bash
git worktree add ../tc-before <commit-before>
(cd ../tc-before && npm ci && npm run build)
TASKCHUTE_E2E_PLUGIN_DIR=../tc-before npm run record:video -- -g "my-feature"
mv e2e-results/recordings/my-feature e2e-results/recordings/my-feature-before
npm run record:video -- -g "my-feature"
```

The "before" run is expected to fail its checks where the bug shows; relax
those checks in a copy of the scenario rather than recording past a failure.

## Publishing

1. Copy `page-template.html` from this skill's folder, fill it in from
   `chapters.json` (one `<li>` per chapter, `data-t` = its `t`), and keep the
   three sections: what was checked (a table: operation → result), the
   recording with its chapter list, and the recording conditions (commit,
   Obsidian version and OS, what was faked, what was not covered).
2. Publish it as an Artifact with the mp4 as a supporting file next to the
   page. Tell the user it is private until they share it.
3. Comment on the issue: one line on what was recorded and on which commit,
   the link, the operation → result table, and the conditions. Keep it short;
   the page has the detail. Do not change the issue's status unless asked.

## When it goes wrong

- **No tasks in the list on macOS** – a note was created without
  `createNotes`; call `reindexVault(page)` before creating notes by hand.
- **"No narration, captions only"** – edge-tts is missing, the network is
  down, or the service refused. The video is still valid.
- **A check times out** – the scenario stops and nothing is encoded. Run the
  matching E2E spec first; a recording is not the place to find a bug.
- **Leftover Obsidian windows** after an interrupted run – they hold the
  debugging port; quit them before the next run.
- **Leftover terminal processes** – terminal runs live in a broker process
  that outlasts the window. The fixture stops running sessions before it
  closes Obsidian, but the broker itself (`node -e … require('net')`) can stay
  behind, and so do the shells of a run that failed midway. Check with
  `ps` and stop what the recording started.
- **Wrong window size** – some window managers refuse the resize; the video is
  then recorded at the size the window has.
