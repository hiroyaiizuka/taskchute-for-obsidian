# GitHub Grass実装設計方針書

## 概要
TaskChute Plusに、GitHubのContribution Graph（通称：GitHub草）のような進捗表示機能を実装する。日々のタスク完了状況を視覚的に把握できるようにし、継続的なタスク実行のモチベーション向上を図る。

## 機能要件

### 1. 表示位置とレイアウト
- **配置場所**: TaskChuteビューの右側（2列レイアウト）
  - 左列: タスクリスト
  - 右列: GitHub Grass
  - 列の間にセパレーター
- **表示サイズ**: 12週間分（84日分）のグリッド
  - 7行（曜日）× 12列（週）= 84マス
  - 各マスのサイズ: 12px × 12px
  - マス間の間隔: 2px
- **コンテナサイズ**: 約180px × 110px（パディング含む）

### 2. 色分けルール
```javascript
const colorScheme = {
  // タスクなし・未実行
  noTask: '#2d333b',  // 暗めのグレー
  
  // 部分的に完了（完了率に応じて段階的に）
  partial: {
    level1: '#0e4429',  // 1-25% (暗めの緑)
    level2: '#006d32',  // 26-50%
    level3: '#26a641',  // 51-75%
    level4: '#39d353',  // 76-99%
  },
  
  // 全タスク完了（先送り0）
  perfect: {
    gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    solid: '#667eea',  // フォールバック用
  }
}
```

### 3. レスポンシブ対応
- **表示条件**: 
  - document.bodyの幅が900px以上の場合に表示
  - CSSメディアクエリで制御
  - ウィンドウリサイズ時に動的に表示/非表示
- **表示切り替えアニメーション**:
  - フェードイン/アウト（0.3秒）

### 4. データ構造とストレージ

#### 日次進捗データ
```typescript
interface DailyProgress {
  date: string;           // YYYY-MM-DD形式
  totalTasks: number;     // 総タスク数
  completedTasks: number; // 完了タスク数
  skippedTasks: number;   // 先送りタスク数
  completionRate: number; // 完了率（0-100）
  isPerfect: boolean;     // 先送り0で全完了
}

interface ProgressData {
  dailyProgress: Record<string, DailyProgress>;
  lastUpdated: string;
}
```

#### 保存場所
- プラグインのデータディレクトリ: `data/progress-history.json`
- 最大保存期間: 90日（約3ヶ月）

### 5. UI/UXデザイン

#### グリッドコンポーネント
```html
<div class="github-grass-container">
  <div class="grass-grid">
    <!-- 曜日ラベル -->
    <div class="grass-weekdays">
      <span>日</span>
      <span></span>  <!-- 月は空 -->
      <span>火</span>
      <span></span>  <!-- 水は空 -->
      <span>木</span>
      <span></span>  <!-- 金は空 -->
      <span>土</span>
    </div>
    <!-- グリッド本体 -->
    <div class="grass-cells">
      <!-- 84個のセル -->
    </div>
  </div>
</div>
```

#### スタイル定義
```css
/* 2列レイアウト */
.taskchute-columns-container {
  display: flex;
  gap: 20px;
  height: 100%;
}

.task-list-container {
  flex: 1;
  overflow-y: auto;
}

.taskchute-separator {
  width: 1px;
  background: var(--background-modifier-border);
}

.grass-column-container {
  width: 200px;
  padding: 10px;
}

.github-grass-container {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  padding: 10px;
}

/* レスポンシブ対応 */
@media (max-width: 899px) {
  .grass-column-container {
    display: none;
  }
  
  .taskchute-separator {
    display: none;
  }
}

.grass-cell {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  cursor: pointer;
  transition: transform 0.2s;
}

.grass-cell:hover {
  transform: scale(1.2);
  z-index: 10;
}

.grass-cell.perfect {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  position: relative;
  overflow: hidden;
}

/* 完璧な日のアニメーション */
.grass-cell.perfect::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 70%);
  animation: perfectPulse 2s ease-in-out infinite;
}

@keyframes perfectPulse {
  0%, 100% { transform: scale(0.8); opacity: 0; }
  50% { transform: scale(1.2); opacity: 1; }
}
```

### 6. インタラクション

#### ホバー時の情報表示
- マウスホバーでツールチップ表示
  - 日付（YYYY年MM月DD日）
  - タスク: X件
  - 完了: Y件 (Z%)
  - 先送りタスク数（ある場合）

#### クリック時の動作
- 該当日付にナビゲート（既存の日付選択機能を利用）

### 7. アニメーションと演出

#### 初回表示時
- 右からスライドイン（0.3秒）
- 各セルが順番にフェードイン（波紋エフェクト）

#### 「おめでとう」モーダル連携
1. 全タスク完了時のフロー：
   - おめでとうモーダル表示
   - モーダル表示から1秒後に該当日のセルをハイライト
   - セルの色がグラデーションに変化（0.5秒）
   - パルスアニメーション開始

#### リアルタイム更新
- タスク完了時に該当日のセルを即座に更新
- 色の変化はスムーズなトランジション（0.3秒）

### 8. 実装優先順位

#### フェーズ1（MVP）
1. 基本的なグリッド表示
2. 日次データの収集と保存
3. 色分け表示
4. レスポンシブ対応

#### フェーズ2（拡張機能）
1. ホバー時のツールチップ
2. クリックでの日付ナビゲーション
3. アニメーション効果
4. おめでとうモーダルとの連携

#### フェーズ3（将来的な機能）
1. 週次・月次サマリー表示
2. ストリーク（連続記録）カウンター
3. カスタマイズ可能な色テーマ
4. データのエクスポート機能

## 技術的実装詳細

### 1. コンポーネント構成
```typescript
class GitHubGrassComponent {
  private container: HTMLElement;
  private progressData: ProgressData;
  private resizeObserver: ResizeObserver;
  
  constructor(private plugin: TaskChutePlugin) {}
  
  // 初期化
  async initialize(): Promise<void> {}
  
  // グリッドの描画
  renderGrid(): void {}
  
  // データの更新
  updateProgress(date: string, data: DailyProgress): void {}
  
  // レスポンシブ対応
  handleResize(): void {}
  
  // クリーンアップ
  destroy(): void {}
}
```

### 2. データ収集タイミング
- タスク完了時
- タスク削除時
- 日付変更時
- プラグイン起動時（当日分の再計算）

### 3. パフォーマンス最適化
- Virtual DOM的なアプローチで差分更新
- データは最大90日分に制限
- アニメーションはGPU加速を活用（transform, opacity）
- 非表示時はレンダリングを停止

### 4. Obsidian APIとの統合
- `workspace.on('resize')` でレイアウト変更を検知
- `registerEvent()` でイベントリスナーを管理
- プラグインのsave/loadData APIでデータ永続化

## テスト計画

### ユニットテスト
- 進捗データの計算ロジック
- 色分けルールの適用
- 日付範囲の計算

### 統合テスト
- タスク操作との連携
- データの永続化
- レスポンシブ動作

### E2Eテスト
- 完全なワークフローのテスト
- アニメーションの動作確認
- エッジケースの処理

## 実装スケジュール

1. **Week 1**: 基本構造とデータモデルの実装
2. **Week 2**: UI/グリッド表示の実装
3. **Week 3**: インタラクションとアニメーション
4. **Week 4**: テストとバグ修正

## 成功指標

- ユーザーの継続率向上
- タスク完了率の向上
- 視覚的フィードバックによるモチベーション向上
- パフォーマンスへの影響が最小限（<50ms）

## リスクと対策

### リスク1: パフォーマンスへの影響
**対策**: 
- レンダリングの最適化
- 必要時のみ更新
- データ量の制限

### リスク2: UIの煩雑化
**対策**:
- シンプルなデザイン
- 適切な表示/非表示制御
- ユーザー設定での無効化オプション

### リスク3: データの不整合
**対策**:
- トランザクション的な更新
- 定期的なデータ検証
- エラーハンドリングの強化