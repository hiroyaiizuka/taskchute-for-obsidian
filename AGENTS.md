# Obsidian community plugin

## Active specifications
- obsidian-plugin-spec-initialization: Initialize a new spec for Obsidian plugin structure and requirements workflow.

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Project rules
- プラグインのソースコードは、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/srcに作成にあります。
- コードを実装したら、npm run testと、npm run lint、npm run buildを実行して、エラーがないことを確認してください。
- 要件定義や仕様書は、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/.kiro/steeringに作成してください。
- 一時的に記載するドキュメントや実装のチェックリストは、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/tmpに作成してください。
- メモリーで記載するノートについては、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/memoryに作成してください。


## 基本方針
- 不明な点は積極的に質問する
- 質問する時は常にAskUserQuestionを使って回答させる
- **選択肢にはそれぞれ、推奨度と理由を提示する**
  - 推奨度は⭐の5段階評価


## Basic Memory ワークフロー

- 最初に、Basic Memory MCPで、switch_project()コマンドを実行し、`taskchute-plus-memory`にプロジェクトをセットしてください。
- ユーザーから実装や調査などの依頼を受けたら着手前に必ずBasic Memoryで既存メモを検索し、`basic-memory__search_notes` や `basic-memory__build_context` などのリード系コマンドで関連知識を取得すること。
- 関連メモが見つかった場合は内容を把握し、既存の決定や方針に従う。該当メモがなければ必要なカテゴリを検討し、作業計画に反映する。
- 実装や検証が完了したらBasic Memoryを起動し、`/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/memory` 配下に新しいメモを作成する。既存ディレクトリが無い場合は命名規則に沿って新規作成する。
- メモは、`/Users/hiroyaiizuka/.basic-memory/knowledge-format.md`に従って作成する。
- メモには最低限、実施日 (YYYY-MM-DD)、依頼内容の要約、実施した変更や調査結果、残課題/フォローアップ、関連ファイルパスやテスト結果を含めること。
- 1つの依頼につき1メモを作成し、再検索しやすいタイトルとタグ付けを心掛ける。

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.


## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
  ```
  src/
    main.ts           # Plugin entry point, lifecycle management
    settings.ts       # Settings interface and defaults
    commands/         # Command implementations
      command1.ts
      command2.ts
    ui/              # UI components, modals, views
      modal.ts
      view.ts
    utils/           # Utility functions, helpers
      helpers.ts
      constants.ts
    types.ts         # TypeScript interfaces and types
  ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):  
  - `id` (plugin ID; for local dev it should match the folder name)  
  - `name`  
  - `version` (Semantic Versioning `x.y.z`)  
  - `minAppVersion`  
  - `description`  
  - `isDesktopOnly` (boolean)  
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**
- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.


## Build & Test
```bash
npm install
npm run dev    # esbuild --watch
npm run build  # production bundle
npm test       # Jest (ts-jest, jsdom)
```
- Husky pre-commit runs `npm run lint` と `npm test`; `HUSKY=0` で一時無効化可能（推奨せず）
- Jest roots: `tests/`
  - `tests/task-sort/…` – slot persistence & ordering
  - `tests/task-display/…` – display/deletion/target_date logic
  - `tests/routine/…` – RoutineService isDue semantics
  - `tests/execution/…` – ExecutionLogService daily summary counts
  - Shared helpers: `tests/utils/taskViewTestUtils.ts`

## Source Conventions
- `src/` 配下は strict TS。主要モジュールは機能別ディレクトリに整理。
  - `features/core/views/TaskChuteView.ts` – メインビューのライフサイクルと UI オーケストレーション
  - `features/core/helpers/` – タスク読み込みや表示判定などのヘルパ群
  - `features/routine/services/RoutineService.ts` – ルーチン frontmatter 正規化と `isDue` ロジック
  - `services/` – DayState 永続化や PathService など共通サービス
  - `types/` – `TaskInstance` や `TaskChuteSettings` 等の共通型定義
- `main.ts` はプラグイン登録処理のみを担当させ、ロジックは各機能モジュールへ委譲
- esbuild バンドルによりランタイム依存を残さない（外部 `obsidian` などは external）

## Slot & Sorting Behavior (2025-09-23 redesign)
- ルーチンのドラッグオーバーライドは日別 `DayState.slotOverrides[path]` に保存
  - `persistSlotAssignment` が更新を反映
  - スロットがデフォルト（frontmatter `開始時刻` 由来）に戻った場合はオーバーライドを削除
  - 非ルーチンは `plugin.settings.slotKeys` を使用
- `createRoutineTask` + `getScheduledSlotKey`
  - `slotOverrides` を優先し、なければ `calculateSlotKeyFromTime`（0-8/8-12/12-16/16-0）でバケット化、最終的に `'none'`
  - Tests: `task-sort-slot-overrides.test.ts`
- 非ルーチン `shouldShowNonRoutineTask`
  - `deletionType === 'permanent'` のみ非表示
  - 一時削除は基のタスクを可視のまま保持（テスト済）
- 日別表示は `metadata.target_date` を尊重（対象日のみ表示）

## Routine Logic
- `RoutineService.parseFrontmatter` normalizes daily/weekly/monthly rules
- `RoutineService.isDue(date, rule, movedTargetDate)` handles:
  - Daily intervals & start anchor
  - Weekly intervals anchored by start-week Monday
  - Monthly `week` (1..5 or `'last'`) and weekday combos
  - `movedTargetDate` short-circuits to single-day visibility
  - Disabled rules return false
- Tests: `routine-service.test.ts`

## Execution Logging & Heatmap
- `ExecutionLogService.saveTaskLog(inst, durationSec)` writes to `<logDataPath>/YYYY-MM-tasks.json`
  - Upserts `taskExecutions[date]`
  - Recomputes `dailySummary[date]` with unique completed count (`completedTasks`)
  - Preserves `totalTasks` if already set (from UI count)
  - Derived fields: `procrastinatedTasks`, `completionRate`
- `TaskChuteView.updateTotalTasksCount()` saves visible count
- Tests: `execution-log-service.test.ts` verifies unique counting and preservation

## Deletion / Duplication Specs
- Routine duplicates stored in `dayState.duplicatedInstances` with slot metadata
- Non-routine duplicates track `instanceId`
- Permanent deletion hides base task for that day; temporary hides only the instance
- Specs referenced: `.kiro/steering/*` documents (slot, display, duplication, completed tasks)

## Tooling
- `esbuild.config.mjs` handles bundling; uses `esbuild --bundle --format=cjs`
- `tsconfig.json` for main build, `tsconfig.test.json` extends for tests
- `eslint.config.mjs` で `eslint-plugin-obsidianmd` と `typescript-eslint` を共有設定化し、`npm run lint` で実行
