# Daily Review機能の使用方法

## 概要
Daily Review機能は、TaskChuteのログデータを活用して1日の振り返りを視覚化する機能です。時間帯別の集中度・疲弊度をグラフで表示し、タスク実行時のコメントを一覧で確認できます。

## 必要なプラグイン
この機能を使用するには、以下のプラグインがインストールされている必要があります：

1. **Dataview** - データの動的な読み込みと表示
2. **Obsidian Charts** - グラフの描画

## セットアップ方法

### 1. テンプレートの設定

1. Obsidianの設定から「テンプレート」を開く
2. テンプレートフォルダを設定（まだ設定していない場合）
3. `templates/daily-review-template.md`をテンプレートフォルダにコピー

### 2. Daily Noteへの適用

#### 方法A: 手動でテンプレートを挿入
1. Daily Note（例：`07_Daily/2025-01-31.md`）を開く
2. コマンドパレット（Cmd/Ctrl + P）を開く
3. 「テンプレート: テンプレートを挿入」を実行
4. `daily-review-template`を選択

#### 方法B: Templaterプラグインを使用（推奨）
1. Templaterプラグインをインストール
2. Daily Noteの自動テンプレート設定で`daily-review-template`を指定

## 表示される情報

### 1. 集中度・疲弊度の推移グラフ
- **横軸**: 0時〜23時の時間帯
- **縦軸**: 1〜5の評価値
- **青線**: 集中度（focusLevel）
- **赤線**: 疲弊度（energyLevel）
- データがない時間帯は空白として表示されます

### 2. タスクコメント一覧
以下の情報がテーブル形式で表示されます：
- **タスク名**: 実行したタスクの名前
- **実行時間**: 開始時刻〜終了時刻
- **所要時間**: タスクにかかった時間（分）
- **集中度**: ⭐で表示（1〜5個）
- **疲弊度**: ⭐で表示（1〜5個）
- **コメント**: タスク実行時に記録したコメント

## トラブルシューティング

### エラー: データが読み込めませんでした
**原因と対処法**：
1. **ログファイルが存在しない**
   - TaskChuteでタスクを実行し、ログが生成されていることを確認
   - ログファイルのパス（`TaskChute/Log/YYYY-MM.json`）を確認

2. **パス設定が異なる**
   - TaskChute Plusの設定でログデータパスを変更している場合は、テンプレートのパスも更新が必要
   - デフォルト: `TaskChute/Log/`
   - 変更方法: テンプレート内の`LOG_DATA_PATH`変数を編集
   ```javascript
   const LOG_DATA_PATH = "あなたのカスタムパス" // 例: "Custom/LogPath"
   ```

3. **その日のデータがない**
   - 当日タスクを実行していない場合は表示するデータがありません

### グラフが表示されない
**原因と対処法**：
1. **Obsidian Chartsプラグインが無効**
   - 設定 → コミュニティプラグイン → Obsidian Chartsを有効化

2. **コードブロックの記法エラー**
   - テンプレートが正しくコピーされているか確認

### テーブルが表示されない
**原因と対処法**：
1. **Dataviewプラグインが無効**
   - 設定 → コミュニティプラグイン → Dataviewを有効化

2. **Dataviewの設定**
   - Dataview設定で「Enable JavaScript Queries」がオンになっているか確認

## カスタマイズ

### グラフの表示幅を変更
テンプレート内の`width: 80%`を変更：
```
width: 100%  # 全幅表示
width: 60%   # 60%幅で表示
```

### グラフの線のスムージング
テンプレート内の`tension: 0`を変更：
```
tension: 0.3  # なめらかな曲線
tension: 0    # 直線（デフォルト）
```

## サンプルスクリーンショット

### 集中度・疲弊度グラフの例
```
[グラフ表示エリア]
- 午前中（9-12時）は集中度が高い
- 午後（14-17時）に疲弊度が上昇
- 夕方以降はデータなし
```

### タスクコメント一覧の例
| タスク名 | 実行時間 | 所要時間 | 集中度 | 疲弊度 | コメント |
|---------|---------|---------|--------|--------|----------|
| 企画書作成 | 09:00 - 10:30 | 90分 | ⭐⭐⭐⭐ | ⭐⭐ | 午前中は集中できた |
| 会議準備 | 11:00 - 11:45 | 45分 | ⭐⭐⭐ | ⭐⭐⭐ | 資料の修正に時間がかかった |

## 注意事項

1. **データのプライバシー**
   - ログファイルには作業内容が含まれるため、共有時は注意してください

2. **パフォーマンス**
   - 大量のタスクデータ（100件以上）がある場合、表示に時間がかかることがあります

3. **データの更新**
   - リアルタイム更新ではないため、最新のデータを見るにはノートを再読み込みしてください（Cmd/Ctrl + R）