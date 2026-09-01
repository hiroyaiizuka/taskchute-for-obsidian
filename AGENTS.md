# TaskChute Plus — Obsidian community plugin

## Project overview

- Target: Obsidian community plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts`, bundled to `main.js` and loaded by Obsidian.
- Release artifacts: `main.js`, `manifest.json`, and `styles.css`.

## Working agreements

- Ask when something is unclear. Use `AskUserQuestion` for questions, and give every
  option a recommendation level (⭐, 1–5) with the reason behind it.
- After changing code, run `npm run test:unit`, `npm run lint`, and `npm run build`, and
  confirm they pass. Run `npm run test:integration` separately when the change touches
  the terminal broker or anything else that spawns real processes — the two suites are
  kept apart on purpose, because running them together starves the integration suites of
  processes and makes them fail spuriously.
- After any change to TaskChute Plus, run the on-device E2E pass with the
  `obsidian-e2e-tester` skill and confirm PASS before reporting the work as done.
- Where documents go:
  - Requirements and specs → `.kiro/steering/`
  - Scratch notes and implementation checklists → `tmp/`
  - Memory notes → `memory/`

## Memory workflow

Reading, writing, searching, and the structure of memory are owned by the
**memory-manager skill**. At the start of a session, read `memory/corrections/lessons.md`.

```
memory/
├── schemas/           # Schema definitions (do not edit)
├── events/            # Implementation logs, feature work
├── bugfixes/          # Bug investigation and fixes
├── investigations/    # Architecture exploration, root-cause analysis
├── designs/           # Design decisions, ADRs
├── corrections/       # Mistakes, distilled into lessons
│   ├── inbox.md       # Write mistakes down immediately
│   ├── lessons.md     # Distilled lessons
│   └── graduated.md   # Lessons already built into process
├── reviews/           # Code-review findings
└── archive/           # Old notes
```

| What happened | Category | Destination | type |
|---|---|---|---|
| Feature work, refactoring | event | `events/` | event |
| Bug fix | bugfix | `bugfixes/` | bugfix |
| Code investigation, analysis | investigation | `investigations/` | investigation |
| Design decision, tech selection | design | `designs/` | design |
| Code review | review | `reviews/` | review |
| Mistake, failure | correction | append to `corrections/inbox.md` | correction |

Search:

```bash
bm tool search-notes "{query}" --project taskchute-plus-memory
```

## Environment & tooling

- Node.js: current LTS (18+).
- Package manager: **npm** — the scripts and dependencies in `package.json` assume it.
- Bundler: **esbuild** via `esbuild.config.mjs` (`--bundle --format=cjs`); `obsidian` and
  friends stay external, everything else is bundled so there are no runtime deps.
- Types: the `obsidian` type definitions.
- `tsconfig.json` drives the main build; `tsconfig.test.json` extends it for tests.

### Testing on a mobile device without cutting a release

`npm run dev` writes `main.js` at the repo root by default. Point the output at a vault's
plugin folder on iCloud Drive instead and every save reaches iPhone / iPad — no Obsidian
Sync subscription needed.

1. Create a test vault under iCloud; iOS Obsidian opens a vault at this path directly:

   ```
   ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault>
   ```

2. Put the destination in `.env` at the repo root (already gitignored):

   ```
   OBSIDIAN_PLUGIN_DIR=/Users/<you>/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault>/.obsidian/plugins/taskchute-plus
   ```

   Spaces in the value need no quotes — Node's `--env-file` reads to end of line.
3. Leave `npm run dev` running while you edit. Each save writes `main.js`,
   `manifest.json`, and `styles.css` into the vault (CSS-only changes included).
4. On the device, toggle the plugin off and on under Settings → Community plugins to
   reload it.

Notes:
- Vault-targeted builds drop the inline sourcemap, so a 10MB bundle isn't synced every time.
- Only `npm run dev` reads `.env` (`--env-file-if-exists=.env`). `npm run build` does not,
  so release artifacts always land at the repo root.
- If iCloud is slow to propagate, opening the folder in Finder nudges the transfer.

## Build & test

```bash
npm install
npm run dev    # esbuild --watch
npm run build  # production bundle
npm run test:unit        # Jest (ts-jest, jsdom)
npm run test:integration # Jest, *.integration.test.ts only (real processes, PTYs, sockets)
```

- The Husky pre-commit hook runs only `eslint` on staged files via `lint-staged`.
  `HUSKY=0` disables it temporarily (not recommended).
- Type checking and the test suite are CI's job (`.github/workflows/test.yml`). Locally,
  `npm run typecheck` and `npm run test:unit` are optional.
- Jest roots: `tests/`
  - `tests/task-sort/…` – slot persistence & ordering
  - `tests/task-display/…` – display / deletion / `target_date` logic
  - `tests/routine/…` – `RoutineService.isDue` semantics
  - `tests/execution/…` – `ExecutionLogService` daily summary counts
  - Shared helpers: `tests/utils/taskViewTestUtils.ts`

## Linting & release review

- `eslint.config.mjs` combines `eslint-plugin-obsidianmd` with `typescript-eslint` as the
  shared config; run it with `npm run lint`.
- `eslint.review.config.mjs` is a separate thing: it *is* Obsidian's automated review
  standard. It **spreads** `eslint-plugin-obsidianmd`'s `configs.recommended` rather than
  transcribing it, and also covers `manifest.json`, `LICENSE`, and `package.json`. Run it
  with `npm run review:obsidian`; the release workflow runs the same check before the
  version bump. Errors fail the release; warnings are reported only — the same way
  Obsidian itself judges it.
- The dashboard's malware and dependency-vulnerability scans have no public API and can't
  be reproduced locally, so passing here is not a guarantee of approval — only the
  converse holds: if it fails here, it will be flagged there.

## File & folder conventions

- Split functionality across modules instead of piling it into `main.ts`.
- Source lives in `src/`. Keep `main.ts` to plugin lifecycle only — load, unload, command
  registration — and delegate feature logic to modules.
- Never commit build artifacts (`node_modules/`, `main.js`, other generated files).
- Keep the plugin small. Avoid large dependencies; prefer browser-compatible packages.
- Release artifacts must end up at the top level of the plugin folder in the vault
  (`main.js`, `manifest.json`, `styles.css`).

### Source layout

- `features/core/views/TaskChuteView.ts` – main view lifecycle and UI orchestration
- `features/core/helpers/` – task loading, display predicates, and similar helpers
- `features/routine/services/RoutineService.ts` – routine frontmatter normalization and
  `isDue` logic
- `services/` – shared services such as DayState persistence and `PathService`
- `types/` – shared types (`TaskInstance`, `TaskChuteSettings`, …)

## Coding conventions

- Strict TypeScript (`"strict": true`) throughout `src/`.
- If a file grows past ~200–300 lines, consider splitting it.
- Give each file a single, well-defined responsibility.
- Avoid Node/Electron APIs when mobile compatibility matters; set `isDesktopOnly`
  accordingly.
- Prefer `async/await` over promise chains, and handle errors gracefully.

## Manifest rules (`manifest.json`)

- Required (non-exhaustive): `id` (matches the folder name for local dev), `name`,
  `version` (SemVer `x.y.z`), `minAppVersion`, `description`, `isDesktopOnly`.
  Optional: `author`, `authorUrl`, `fundingUrl` (string or map).
- Never change `id` after release — treat it as stable API.
- Keep `minAppVersion` accurate when adopting newer APIs.
- Canonical requirements: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
  (`obsidian-releases`' `validate-plugin-entry.yml` no longer exists; entry validation
  moved to the automated review on the developer dashboard.)
- The reproducible part of that review is `npm run review:obsidian` — it's also the first
  place `manifest.json` is actually validated.

## Agent do / don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use the `this.register*` helpers for anything needing cleanup.

**Don't**
- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features requiring cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Domain notes

### Routine logic

- `RoutineService.parseFrontmatter` normalizes daily / weekly / monthly rules.
- `RoutineService.isDue(date, rule, movedTargetDate)` handles:
  - Daily intervals and the start anchor
  - Weekly intervals anchored to the start week's Monday
  - Monthly `week` (1..5 or `'last'`) combined with weekdays
  - `movedTargetDate`, which short-circuits to single-day visibility
  - Disabled rules, which return false
- Tests: `routine-service.test.ts`

### Execution logging & heatmap

- `ExecutionLogService.saveTaskLog(inst, durationSec)` writes to
  `<logDataPath>/YYYY-MM-tasks.json`:
  - Upserts `taskExecutions[date]`
  - Recomputes `dailySummary[date]` with a unique completed count (`completedTasks`)
  - Preserves `totalTasks` when already set from the UI count
  - Derives `procrastinatedTasks` and `completionRate`
- `TaskChuteView.updateTotalTasksCount()` saves the visible count.
- Tests: `execution-log-service.test.ts` covers unique counting and preservation.

### Deletion & duplication

- Routine duplicates live in `dayState.duplicatedInstances` with slot metadata.
- Non-routine duplicates track `instanceId`.
- Permanent deletion hides the base task for that day; temporary deletion hides only the
  instance.
- Specs: the `.kiro/steering/*` documents (slot, display, duplication, completed tasks).
