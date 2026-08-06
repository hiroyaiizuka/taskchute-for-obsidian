# TaskChute Plus

[English](./README.md) | [日本語](./README.ja.md)

**タスクを整理するだけでなく、実行するためのプラグイン。**

![TaskChute Plus - Execute tasks, don't just organize them](assets/taskchute-social-card.png)

TaskChute Plus は、実行重視のタスク管理を Obsidian 上で行うためのプラグインです。  
「今やること」を決めて実行し、実績ログを蓄積して改善につなげます。

> [!warning]
> **バージョン 2.0.0 以降、TaskChute Plus はオープンソースではありません。** プラグイン自体は
> 引き続き無料で利用できます。ソースコードは非公開リポジトリで管理しており、本リポジトリでは
> ビルド成果物（`main.js` / `manifest.json` / `styles.css`）のみを GitHub Releases として配布します。
>
> v1 時点のソースコードは MIT ライセンスのまま公開しています:
> [v1 source code](https://github.com/hiroyaiizuka/taskchute-for-obsidian/tree/v1)
> （タグ `v1-oss-final`）

> [!note]
> **データはあなたの vault の中に置かれます。** タスク・実行ログ・レビュー・ヒートマップの
> データはすべて、あなたの vault 内に Markdown と JSON として保存されます。現時点では、
> これらのデータを外部へ送信する機能はありません。

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

後述の[インストール方法](#インストール方法)を参照し、`Open TaskChute` コマンドを実行してください。

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

## CHANGELOG

変更履歴は[こちら](./CHANGELOG.md)を参照してください。

## インストール方法

| 入手元 | 説明 |
|---|---|
| [Obsidian Plugin Market](https://obsidian.md/plugins?id=taskchute-plus) | Obsidian の `Settings -> Community plugins` からインストール |
| [GitHub](https://github.com/hiroyaiizuka/taskchute-for-obsidian/releases/latest) | 最新リリースをダウンロードし、3ファイル（`main.js` / `manifest.json` / `styles.css`）を `{{obsidian_vault}}/.obsidian/plugins/taskchute-plus/` に配置 |
| BRAT | BRAT に `hiroyaiizuka/taskchute-for-obsidian` を追加 |

## ソースコード

本リポジトリは配布専用です。プラグイン本体のソースコードは非公開リポジトリで管理しており、
ビルド成果物を GitHub Releases としてここで配布します。

Obsidian はプラグインルートの以下を読み込みます。これらは各リリースに添付されます。

- `main.js`
- `manifest.json`
- `styles.css`

## ライセンス

- **バージョン 2.0.0 以降** — プロプライエタリ。[LICENSE](./LICENSE) を参照。個人利用・商用利用を
  問わず無償で利用できます。自分の環境での私的な改変は可、再配布は不可です。
- **バージョン 1.7.10 以前** — MIT License。
  [`v1` ブランチの LICENSE](https://github.com/hiroyaiizuka/taskchute-for-obsidian/blob/v1/LICENSE)
  を参照（タグ `v1-oss-final`）。

## 作者

Hiroya Iizuka
