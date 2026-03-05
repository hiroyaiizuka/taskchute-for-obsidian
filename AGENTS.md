# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Project rules
- プラグインのソースコードは、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/srcに作成にあります。
- コードを実装したら、npm run testと、npm run lint、npm run buildを実行して、エラーがないことを確認してください。
- TaskChute Plusのコード変更後は、完了報告前に必ず`obsidian-e2e-tester`スキルで実機E2Eを実施し、PASSを確認すること（詳細: /Users/hiroyaiizuka/Desktop/Evergreens/.agents/skills/obsidian-e2e-tester/SKILL.md）。
- 要件定義や仕様書は、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/.kiro/steeringに作成してください。
- 一時的に記載するドキュメントや実装のチェックリストは、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/tmpに作成してください。
- メモリーで記載するノートについては、/Users/hiroyaiizuka/Desktop/Evergreens/.obsidian/plugins/taskchute-plus/memoryに作成してください。


## 基本方針
- 不明な点は積極的に質問する
- 質問する時は常にAskUserQuestionを使って回答させる
- **選択肢にはそれぞれ、推奨度と理由を提示する**
  - 推奨度は⭐の5段階評価


## Basic Memory ワークフロー

メモリの読み書き・検索・構造の詳細は **memory-manager スキル** に集約。

- **セッション開始時**: `memories/corrections/lessons.md` を読む


### メモリ構造

```
memory/
├── schemas/           # スキーマ定義（触らない）
├── events/            # 実装ログ・機能追加
├── bugfixes/          # バグ調査と修正
├── investigations/    # アーキテクチャ探索・原因調査
├── designs/           # 設計決定・ADR
├── corrections/       # 失敗と教訓の蒸留
│   ├── inbox.md       # ミスをすぐ書く
│   ├── lessons.md     # 蒸留された教訓
│   └── graduated.md   # 仕組み化済み
├── reviews/           # コードレビュー所見
└── archive/           # 古いメモ
```

### 記録ルール

| 何をした | カテゴリ | 保存先 | type |
|---------|----------|--------|------|
| 機能実装・リファクタリング | event | `events/` | event |
| バグ修正 | bugfix | `bugfixes/` | bugfix |
| コード調査・分析 | investigation | `investigations/` | investigation |
| 設計決定・技術選定 | design | `designs/` | design |
| コードレビュー | review | `reviews/` | review |
| ミス・失敗 | correction | `corrections/inbox.md` に追記 | correction |

### 検索
```bash
/Users/hiroyaiizuka/.local/bin/bm -p taskchute-plus-memory tool search-notes "{検索語}"
```
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


## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.


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
