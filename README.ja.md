# TaskChute Plus

[English](./README.md) | [日本語](./README.ja.md)

📖 **公式ドキュメント:** https://obsidian.levers.co.jp/ja/

**タスクを整理するだけでなく、実行するためのプラグイン。**

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
- Pro設定：ライセンスの有効化、デバイスのシート管理、それによって使えるAIタスクの各種設定（デスクトップのみ）

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

## AIタスク（実験的機能・デスクトップ専用）

タスクをAI CLI（Claude Code / Codex）で実行し、タスクリスト下の「AI実行」ペインに埋め込まれた本物のターミナルで操作できます。対話型TUIがそのまま描画され、タスクノートのプロンプトが自動投入されたあとも、自分のターミナルでCLIを起動したときと同じように、いつでもセッションに直接入力できます。

- `TaskChute settings` → `AIタスク` → `AIタスクを有効化` でオンにします。デフォルトはオフで、モバイルでは動作しません。
- AIタスクの利用には**Proライセンス**の有効化が必要です。`TaskChute settings` → `Pro設定` でアクティベーションコードを入力してください。同じページでシートを使用中のデバイスの一覧と解放も行えます。送信内容は[ネットワーク通信について](#ネットワーク通信について)を参照してください。
- プラグインは手元にあるCLIを起動するだけです。**Claude Code（`claude`）や Codex（`codex`）のインストールと認証は、各自で事前に済ませておく必要があります。** プラグイン自身はAPIキーを扱わず、Vaultの内容をAIサービスへ送信することもありません。CLIは各自が認証したアカウントで、それぞれの提供元と通信します。
- 自動検出に失敗する場合は、同じ設定セクションでバイナリの絶対パスを指定してください。

### ネットワーク通信について

プラグインがネットワーク通信を行うのは、Proライセンスの検証のためだけです。通信先はライセンスAPI `https://taskchute-license.levers.workers.dev`、経路はHTTPSです。

- **通信のタイミング** — アクティベーションコードの登録時とデバイスのシート解放時、`Pro設定` ページでシート使用状況を一覧するとき（最短1分に1回まで）、そしてこのデバイスに保存された署名付きトークンの有効期限が近いとき（12時間ごとに確認、トークンの有効期間は7日）。更新の合間はトークンをオフラインで検証するため、接続がない環境でもそのまま利用できます。
- **送信する内容** — ライセンスコード、このプラグインが生成したランダムなデバイスID、デバイスの一覧でシートを見分けるためのラベル（マシンのホスト名、取得できない場合はプラットフォーム名と、Vault名）、プラットフォーム名、プラグインのバージョン。
- **送信しない内容** — タスク・ノート・ログ・プロンプトの内容は一切送信しません。テレメトリや利用状況の収集も行いません。上記以外にネットワーク通信を行う箇所はありません。

タスクノートに frontmatter を付け、`## Prompt` セクションを追加します。

```markdown
---
ai_task: true
ai_task_host: claude        # 任意: claude（デフォルト）または codex
ai_task_cwd: Projects/demo  # 任意: 作業ディレクトリ（Vault相対または絶対パス）
ai_task_args: --max-turns 5 # 任意: 追加のCLI引数（文字列またはリスト）
---

## Prompt

このプロジェクトの未解決の論点を要約し、次のステップを提案して。
```

タスク行に実行ボタンが表示され、実行中は停止ボタンとステータスチップに切り替わります。実行が終わるたびにログノート（色制御コードを除去したターミナルのトランスクリプト）が `TaskChute/AI/Logs/YYYY-MM/` に保存され、`実行ログの保持期間（日）`（デフォルト30日）より古いログノートは自動的にゴミ箱へ移動されます。

### 実行モード

- **ターミナル（対話型）** — 上記のデフォルト体験です。ターミナルモードでは `## Prompt` セクションは省略可能で、無い場合はCLIが素の対話セッションとして開きます。
- **ヘッドレス（イベント表示）** — 従来の動作で、`TaskChute settings` → `AIタスク` → `実行モード` から選択できます。CLIを非対話で実行し、解析されたストリームイベントをペインにテキスト表示し、コンポーザーバーから resume ベースの追加プロンプトを送信できます。ヘッドレス実行には `## Prompt` セクションが必須です。
- **Windows** は現時点でターミナル非対応のため、設定に関わらず常にヘッドレスで実行されます。

この機能にとってタスクノートの frontmatter は読み取り専用です。プラグインがタスクノートを書き換えることはありません。

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
npm run test:unit        # jest（ユニット）
npm run test:integration # jest（*.integration.test.ts / 実プロセスを起動）
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
