# TaskChute for Obsidian (TaskChute Plus)

[English](./README.md) | [日本語](./README.ja.md)

📖 **Documentation:** https://obsidian.levers.co.jp/

**Execute tasks, don't just organize them.**

TaskChute for Obsidian (TaskChute Plus) is the official TaskChute plugin for Obsidian.
TaskChute is a task management method created by Etsuo Ohashi, and this plugin is endorsed by
the TaskChute Association (一般社団法人タスクシュート協会), where he serves as representative director.

It is built for execution-first task management: you decide what to do now, run it,
and keep a reliable log of what actually happened.

## What You Can Do

- Manage daily tasks in one TaskChute view with date navigation.
- Start/stop tasks and track actual execution time.
- Group tasks by configurable time slots plus a `No time` section.
- Create and run routines (daily, weekly, monthly patterns).
- Move, duplicate, reset, and delete task instances with day-state persistence.
- Link tasks to projects and open project board views.
- Review history from execution logs and yearly heatmap data.
- Set reminder times per task.
- Comment on a running task, and leave comments for the day (today's comments).
- Assign a recipe to a task — a reusable way of working: definition of done, steps, quality checks, and constraints.
- Export tasks to Google Calendar URL scheme.
- AI tasks (Pro): hand off work to Claude Code, Codex, or Cursor and run it in a terminal (desktop only).
- Japanese/English UI (follows Obsidian's language setting).

## Commands

Available from Obsidian Command Palette:

- `Open TaskChute`
- `TaskChute settings`
- `Show today's tasks`
- `Reorganize idle tasks to current slot`
- `Duplicate selected task` (when TaskChute view is active)
- `Delete selected task` (when TaskChute view is active)
- `Reset selected task` (when TaskChute view is active)

## Getting Started

### Install in Obsidian

1. Open `Settings -> Community plugins`.
2. Install/enable `TaskChute Plus`.
3. Run the command `Open TaskChute`.

### First Task

You can create tasks from the TaskChute UI, or manually create a note in your task folder.

Minimal manual example:

```md
---
tags:
  - task
target_date: "2026-04-16"
scheduled_time: "09:00"
---

# Online consultation
```

`#task` in note body is also supported for legacy compatibility.

## Settings Overview

Open `TaskChute settings` to configure:

- Storage location mode (`vaultRoot` or `specifiedFolder`)
- Project folder path (optional, independent path)
- Review template path and filename pattern
- Day comments (off by default), recipe feature (off by default)
- Reminder default minutes
- Backup interval/retention for execution snapshots
- Custom time-slot boundaries and collapsible slot UI
- Google Calendar export defaults
- Pro settings: license activation, device seats, and the AI task options they unlock (desktop only)

Current default values in code:

- `backupIntervalHours: 2`
- `backupRetentionDays: 1`
- `defaultReminderMinutes: 5`
- `locationMode: vaultRoot`

## Default Paths

With default `vaultRoot` mode, TaskChute-managed folders are:

- `TaskChute/Task`
- `TaskChute/Log`
- `TaskChute/Review`

`projectsFolder` is intentionally unset by default and can be configured separately.

## AI tasks (Pro, desktop only)

Hand a task off to an AI agent (Claude Code / Codex / Cursor) and run it in a real terminal embedded in the "AI runs" pane below the task list. The interactive TUI renders there, the task's instructions are submitted automatically, and you can type into the session directly at any time — exactly as if you had launched the CLI in your own terminal.

See the official docs for details: [AI tasks and the Pro license](https://obsidian.levers.co.jp/howto/pro-license)

- Needs an activated **Pro license**. Enter your activation code in `TaskChute settings` → `Pro settings` and turn on `Enable AI tasks`. The same page lists the devices currently holding a seat and lets you release one. The activation code is stored per device and is not synced. See [Network use](#network-use) for what activation sends.
- Works on Windows (Windows 10 version 1809 or later), macOS, and Linux. It does not work on mobile. On macOS and Linux, the terminal runs on Node.js.
- The plugin only launches the CLI you already have: **Claude Code (`claude`), Codex (`codex`), and Cursor (`cursor-agent`) must be installed and authenticated separately by you.** The plugin itself handles no API keys. The CLI talks to its provider under the account you authenticated it with.
- The CLI is auto-detected. Only if detection fails, set the absolute path in the matching CLI path (advanced fallback) field in `Pro settings`.

### Network use

The plugin makes network requests for exactly one purpose: verifying a Pro license against the license API at `https://taskchute-license.levers.workers.dev`, over HTTPS.

- **When** — when you activate a code or release a device seat, when the `Pro settings` page lists the seats in use (throttled to at most one check a minute), and when the signed token stored on this device is close to expiring (checked every 12 hours; tokens are valid for 7 days). Between refreshes the token is verified offline, so a vault without a connection keeps working.
- **What is sent** — the license code, a random device id generated by this plugin, a device label (your machine's hostname, or its platform name, together with the vault name) so seats are distinguishable in the device list, the platform name, and the plugin version.
- **What is never sent** — no task, note, log or prompt content, and no telemetry or analytics of any kind. Nothing else in the plugin contacts the network.

### Creating AI tasks

AI tasks are created from the task creation screen by choosing `Task type` → `AI task` (for an existing task, use ⚙ → `🔁 Change task type`). The screen lets you choose the agent, the instructions (prompt), the execution mode (Manual / Auto mode / Skip permissions), the model, the reasoning mode, the working directory, and a recipe. These settings are saved to the task note's frontmatter and its `## Prompt` section.

```markdown
---
ai_task: true
ai_task_host: claude        # claude (default) / codex / cursor
ai_task_cwd: Projects/demo  # optional: working directory (vault-relative or absolute)
ai_task_args:               # execution mode, model, etc. chosen on screen
  - --permission-mode
  - auto
---

## Prompt

Summarize the open questions in this project and propose next steps.
```

- Of `ai_task_args`, only the arguments the creation screen can set are passed to the CLI. Any others are not used, and a notice is shown instead (so a synced or shared note cannot change what the CLI does on its own).
- "Skip permissions," and a working directory outside the vault (and, for Cursor, "Trust this folder"), need to be allowed on this device. The first ▶ run asks for confirmation, and the allowance is stored on this device only (not synced).

### Running

- Starting a task row with ▶ opens a terminal tab in the "AI runs" pane. + opens a plain terminal, ◫ splits the pane, and the file list lets you open files in the working directory.
- Each run saves a log note (the terminal transcript, colors stripped) under `TaskChute/AI/Logs/YYYY-MM/`, and log notes older than `Run log retention (days)` (default 30) are moved to the trash automatically.
- **Session history**: list and full-text search past Claude Code / Codex / Cursor conversations that ran in a vault folder, and resume one (command `Open AI session history`).
- **Automatic start**: an AI task that is a routine starts automatically at its scheduled time (checked once a minute, once a day). Because an automatic start cannot ask for confirmation, "Skip permissions" runs in auto mode unless it has already been allowed, and the task will not start in a working directory that has not been allowed.
- **Linking to a human task**: in the routine settings' "Obsidian integration" section, you can make an AI task start whenever a human task with a chosen name starts. Stopping, resetting, deleting, and moving the date stay linked too.
- **Recipes**: assign a recipe to an AI task and its definition of done, steps, quality checks, and constraints are attached to the first instructions sent to it.

### When the terminal is unavailable

- The terminal is used everywhere by default. Where it isn't available, the run uses conversation mode instead — the CLI runs non-interactively, events render as text in the pane, and follow-up instructions are sent from the pane's input box — and a notice says why.
- **Windows** runs the terminal inside a Windows pseudo console (ConPTY) hosted by the built-in Windows PowerShell, so nothing extra has to be installed. It needs Windows 10 version 1809 or later. The first terminal run checks that the pseudo console works on the machine; where it cannot (an older build, or PowerShell locked down by policy), it runs in conversation mode instead. On Windows the pane does not offer plain shell sessions (+ or split), and a terminal session ends when the CLI exits.

## Development

### Requirements

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Scripts

```bash
npm run dev       # esbuild watch
npm run build     # production bundle
npm run lint      # eslint for src/tests
npm run test:unit        # jest (unit suites)
npm run test:integration # jest (*.integration.test.ts; spawns real processes)
```

### Release Artifacts

Obsidian loads these files from the plugin root:

- `main.js`
- `manifest.json`
- `styles.css`

## License

MIT

## Author

Hiroya Iizuka
