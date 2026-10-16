---
name: obsidian-e2e-tester
description: Run TaskChute Plus inside a real Obsidian desktop app and check it end to end with `npm run test:e2e`. Use after any change to the plugin, before reporting the work as done, and when asked to verify behaviour "on device" or "in Obsidian".
---

# Obsidian E2E tester

`npm run test:e2e` builds the plugin, starts a real Obsidian desktop app on a
throwaway vault with the build installed, and drives it with Playwright. The
suite lives in `e2e/`; design notes are in issue #193.

## When

- After any change to TaskChute Plus, once `npm run test:unit`, `npm run lint`
  and `npm run build` pass. **PASS means every test in `npm run test:e2e`
  passed.**
- When a change touches something jsdom cannot show: plugin load, command
  registration, view layout, settings, locale.

## Run

```bash
npm run test:e2e                                        # build + whole suite
TASKCHUTE_E2E_SKIP_BUILD=1 npm run test:e2e             # reuse the current main.js
npx playwright test -c e2e -g "settings"                # one test by name
```

Report the pass/fail counts from the `list` reporter output. Never report PASS
for a run that failed or was skipped; say which tests failed and why.

## Requirements

- **Linux x64 only** for now (WSL2 with WSLg works). macOS / Windows / CI are
  not wired up yet.
- **A display.** WSLg and desktop sessions have one. On a headless box run
  `xvfb-run -a npm run test:e2e`.
- **No sudo needed.** The first run downloads the pinned Obsidian AppImage
  (~140 MB) and any missing Electron libraries (`libnss3`, `libasound2t64`, …)
  via `apt-get download` into `~/.cache/taskchute-e2e/`
  (override with `TASKCHUTE_E2E_CACHE`). Later runs reuse the cache.
- Each test opens an Obsidian window for about a second. On WSLg the windows
  appear on the Windows desktop; that is expected.

## When a test fails

- Artifacts land in `e2e-results/` (gitignored):
  - `e2e-results/output/<test>/` – the attached screenshot, console log, and
    `error-context.md` (the page's accessibility snapshot at failure).
    `run/vault` in the same folder is the vault the test used, including
    everything the plugin wrote.
  - `e2e-results/report/` – HTML report (`npx playwright show-report e2e-results/report`).
- Every test also fails if Obsidian logged a console error or an uncaught
  exception while it ran. The console attachment shows which.
- Obsidian 1.13 opens **settings in a popout window**; query settings through
  `window.app.setting`, not the main window's DOM.

## Writing tests

- Import `test` / `expect` from `e2e/fixtures.ts`. The `obsidian` fixture
  gives `{ page, vaultDir, errors, consoleLines }` for a fresh Obsidian.
- Pick the UI language with `test.use({ language: "ja" })` (default `en`).
- Drive the plugin with locators and
  `window.app.commands.executeCommandById("taskchute-plus:…")`; check state in
  the DOM or in files under `vaultDir`.
- Internal `window.app` members the tests use are typed in
  `e2e/obsidian/globals.d.ts`; extend it when you need more.

## How it works (for maintenance)

- `e2e/obsidian/install.ts` downloads and extracts the pinned AppImage.
  `OBSIDIAN_VERSION` in `e2e/obsidian/paths.ts` is the pin; only tags that ship
  an AppImage qualify (v1.13.8 is Android-only).
- `e2e/obsidian/launch.ts` spawns Obsidian with `--user-data-dir` and
  `--remote-debugging-port`, then attaches with `chromium.connectOverCDP`.
  Playwright's `_electron.launch()` does not work: Obsidian's Electron disables
  Node's `--inspect`.
- The vault is trusted and the language set through localStorage
  (`enable-plugin-<vaultId>`, `language`) followed by a window reload. Neither
  `obsidian.json`'s `language` nor `--lang` has any effect.
- Obsidian runs in its own process group and the whole group is killed after
  each test. A surviving helper would keep the debugging port and the next run
  would attach to the stale instance, so the launcher also checks that the
  window it attached to has the test's vault open.
