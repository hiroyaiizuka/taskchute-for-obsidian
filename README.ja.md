# TaskChute Plus

[English](./README.md) | [日本語](./README.ja.md)

**タスクを整理するだけでなく、実行するためのプラグイン。**

![TaskChute Plus - Execute tasks, don't just organize them](taskchute-docs/static/img/taskchute-social-card.png)

TaskChute Plus は、実行重視のタスク管理を Obsidian 上で行うためのプラグインです。  
「今やること」を決めて実行し、実績ログを蓄積して改善につなげます。

## できること

- 日付ナビゲーション付きの TaskChute ビューで当日のタスクを管理
- タスクの開始/停止と実作業時間の記録
- カスタム可能な時間帯スロット + `時間指定なし` での表示
- ルーチン（毎日/毎週/毎月）の作成と運用
- タスクインスタンスの移動・複製・リセット・削除（day state 永続化）
- タスクとプロジェクトの紐づけ、およびプロジェクトボード表示
- 実行ログと年次ヒートマップの確認
- タスクごとのリマインダー設定
- Google Calendar URL スキームへのエクスポート
- 日本語/英語 UI（または Obsidian 言語設定に追従）

## コマンド

Obsidian のコマンドパレットから利用できます。

- `Open TaskChute`
- `TaskChute settings`
- `Show today's tasks`
- `Reorganize idle tasks to current slot`
- `Duplicate selected task`（TaskChuteビューがアクティブ時）
- `Delete selected task`（TaskChuteビューがアクティブ時）
- `Reset selected task`（TaskChuteビューがアクティブ時）

## はじめ方

### Obsidian へのインストール

1. `Settings -> Community plugins` を開く
2. `TaskChute Plus` をインストールして有効化
3. `Open TaskChute` コマンドを実行

### 最初のタスク

TaskChute の UI から作成するか、タスクフォルダに手動でノートを作成します。

最小の手動例:

```md
---
tags:
  - task
target_date: "2026-04-16"
scheduled_time: "09:00"
---

# オンライン診療
```

互換性のため、本文中の `#task` タグ検出もサポートしています。

## 設定概要

`TaskChute settings` で次を設定できます。

- 保存先モード（`vaultRoot` / `specifiedFolder`）
- プロジェクトフォルダ（任意・独立パス）
- レビューテンプレートパスとファイル名パターン
- 言語上書き（`auto`, `en`, `ja`）
- 既定リマインダー分数
- 実行ログスナップショットのバックアップ間隔/保持期間
- カスタム時間帯境界と時間帯折りたたみUI
- Google Calendar エクスポート既定値

現行コードのデフォルト値:

- `backupIntervalHours: 2`
- `backupRetentionDays: 1`
- `defaultReminderMinutes: 5`
- `locationMode: vaultRoot`

## デフォルトの保存パス

`vaultRoot` モードでは、TaskChute 管理フォルダは次になります。

- `TaskChute/Task`
- `TaskChute/Log`
- `TaskChute/Review`

`projectsFolder` はデフォルトで未設定です（必要時に個別指定）。

## 開発

### 要件

- Node.js 18+
- npm

### セットアップ

```bash
npm install
```

### スクリプト

```bash
npm run dev       # esbuild watch
npm run build     # production bundle
npm run lint      # eslint for src/tests
npm test          # jest
```

### リリース成果物

Obsidian はプラグインルートの以下を読み込みます。

- `main.js`
- `manifest.json`
- `styles.css`

## ライセンス

MIT

## 作者

Hiroya Iizuka
