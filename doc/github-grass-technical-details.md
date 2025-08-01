# GitHub Grass実装技術詳細

## アーキテクチャ設計

### コンポーネント階層

```
TaskChutePlugin
├── TaskChuteView
│   ├── DateNavigationComponent
│   ├── TaskListComponent
│   └── GitHubGrassComponent (新規)
│       ├── GrassGrid
│       ├── GrassCell
│       ├── GrassTooltip
│       └── GrassLegend
└── DataManagement
    ├── TaskDataManager
    └── ProgressHistoryManager (新規)
```

## 詳細実装設計

### 1. ProgressHistoryManager

```typescript
interface ProgressHistoryManager {
  // データ管理
  private progressData: Map<string, DailyProgress>;
  private plugin: TaskChutePlugin;
  
  // 初期化・永続化
  async load(): Promise<void>;
  async save(): Promise<void>;
  
  // データ操作
  updateDailyProgress(date: string): Promise<void>;
  getDailyProgress(date: string): DailyProgress | null;
  getProgressRange(startDate: string, endDate: string): DailyProgress[];
  
  // クリーンアップ（90日以上古いデータを削除）
  cleanupOldData(): void;
  
  // イベントハンドラー
  onTaskCompleted(task: Task): void;
  onTaskDeleted(task: Task): void;
  onTaskModified(oldTask: Task, newTask: Task): void;
}
```

### 2. GitHubGrassComponent

```typescript
class GitHubGrassComponent {
  private container: HTMLElement;
  private gridContainer: HTMLElement;
  private cells: Map<string, HTMLElement>;
  private resizeObserver: ResizeObserver;
  private isVisible: boolean = false;
  
  constructor(
    private plugin: TaskChutePlugin,
    private progressManager: ProgressHistoryManager,
    private parentContainer: HTMLElement
  ) {}
  
  // ライフサイクル
  async initialize(): Promise<void> {
    this.createContainer();
    this.setupResizeObserver();
    this.renderInitialGrid();
    this.attachEventListeners();
  }
  
  destroy(): void {
    this.resizeObserver?.disconnect();
    this.container?.remove();
  }
  
  // レンダリング
  private renderInitialGrid(): void {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 83); // 84日分
    
    this.renderDateRange(startDate, endDate);
  }
  
  private renderDateRange(start: Date, end: Date): void {
    // 週ごとにグループ化してレンダリング
    const weeks = this.groupDatesByWeek(start, end);
    weeks.forEach((week, weekIndex) => {
      this.renderWeek(week, weekIndex);
    });
  }
  
  // セルの更新
  updateCell(date: string, progress: DailyProgress): void {
    const cell = this.cells.get(date);
    if (!cell) return;
    
    const color = this.getColorForProgress(progress);
    this.animateCellUpdate(cell, color, progress.isPerfect);
  }
  
  // 色の計算
  private getColorForProgress(progress: DailyProgress): string {
    if (progress.totalTasks === 0) return '#2d333b'; // 暗めのグレー
    if (progress.isPerfect) return 'perfect'; // CSSクラス
    
    const rate = progress.completionRate;
    if (rate <= 25) return '#0e4429'; // 暗めの緑
    if (rate <= 50) return '#006d32';
    if (rate <= 75) return '#26a641';
    if (rate < 100) return '#39d353';
    return '#39d353';
  }
  
  // アニメーション
  private animateCellUpdate(cell: HTMLElement, color: string, isPerfect: boolean): void {
    if (isPerfect) {
      // 特別なアニメーション
      cell.classList.add('updating');
      setTimeout(() => {
        cell.className = 'grass-cell perfect';
        cell.classList.add('pulse');
        setTimeout(() => cell.classList.remove('pulse'), 1000);
      }, 300);
    } else {
      // 通常の色更新
      cell.style.transition = 'background-color 0.3s';
      if (color === 'perfect') {
        cell.className = 'grass-cell perfect';
      } else {
        cell.className = 'grass-cell';
        cell.style.backgroundColor = color;
      }
    }
  }
  
  // レスポンシブ対応
  private checkVisibility(): void {
    // body幅を直接チェック
    const shouldShow = document.body.offsetWidth >= 900;
    this.toggleVisibility(shouldShow);
  }
  
  private toggleVisibility(shouldShow: boolean): void {
    if (shouldShow !== this.isVisible) {
      this.isVisible = shouldShow;
      this.container.classList.toggle('visible', shouldShow);
    }
  }
}
```

### 3. 既存システムとの統合

#### TaskChuteViewの修正

```typescript
// TaskChuteView内での統合
class TaskChuteView extends ItemView {
  private grassComponent: GitHubGrassComponent;
  private progressManager: ProgressHistoryManager;
  
  renderTasks() {
    // 2列レイアウト用のコンテナ
    const columnsContainer = mainContainer.createEl("div", {
      cls: "taskchute-columns-container",
    });
    
    // 左側：タスクリストエリア
    const taskListContainer = columnsContainer.createEl("div", {
      cls: "task-list-container",
    });
    
    // セパレーター
    const separator = columnsContainer.createEl("div", {
      cls: "taskchute-separator",
    });
    
    // 右側：GitHub Grassコンテナ
    const grassColumnContainer = columnsContainer.createEl("div", {
      cls: "grass-column-container",
    });
    
    // GitHub Grassコンポーネントをここで初期化
    if (!this.grassComponent && this.progressManager) {
      this.grassComponent = new GitHubGrassComponent(
        this.plugin,
        this.progressManager,
        grassColumnContainer
      );
      this.grassComponent.initialize();
    }
    
    // タスクレンダリングは左側のコンテナに
    // ... 既存のタスクレンダリングコード
  }
  
  private setupProgressTracking(): void {
    // タスク完了時
    this.on('task-completed', (task: Task) => {
      this.progressManager.onTaskCompleted(task);
      this.updateGrassForDate(task.date);
    });
    
    // タスク削除時
    this.on('task-deleted', (task: Task) => {
      this.progressManager.onTaskDeleted(task);
      this.updateGrassForDate(task.date);
    });
    
    // 日付変更時
    this.on('date-changed', (newDate: string) => {
      // 前日の最終状態を確定
      this.progressManager.updateDailyProgress(this.previousDate);
      // 新しい日付の進捗を更新
      this.progressManager.updateDailyProgress(newDate);
    });
  }
  
  private updateGrassForDate(date: string): void {
    const progress = this.progressManager.getDailyProgress(date);
    if (progress) {
      this.grassComponent.updateCell(date, progress);
    }
  }
}
```

#### おめでとうモーダルとの連携

```typescript
// 既存のshowCelebrationModal関数の拡張
showCelebrationModal(): void {
  // 既存のモーダル表示コード...
  
  // GitHub Grassの更新をトリガー
  setTimeout(() => {
    const today = this.getCurrentDateString();
    const progress = this.progressManager.getDailyProgress(today);
    if (progress && progress.isPerfect) {
      // 特別なアニメーションでセルを更新
      this.grassComponent.celebrateDay(today);
    }
  }, 1000);
}
```

### 4. データストレージ最適化

```typescript
// データ圧縮と効率的な保存
interface CompressedProgressData {
  version: number;
  data: string; // 圧縮されたJSON文字列
  lastUpdated: string;
}

class ProgressDataCompressor {
  // 90日分のデータを効率的に圧縮
  static compress(data: Map<string, DailyProgress>): string {
    const array = Array.from(data.entries())
      .map(([date, progress]) => ({
        d: date.slice(5), // 年を省略
        t: progress.totalTasks,
        c: progress.completedTasks,
        s: progress.skippedTasks,
        p: progress.isPerfect ? 1 : 0
      }));
    
    return JSON.stringify(array);
  }
  
  static decompress(compressed: string, year: number): Map<string, DailyProgress> {
    const array = JSON.parse(compressed);
    const map = new Map<string, DailyProgress>();
    
    array.forEach((item: any) => {
      const date = `${year}-${item.d}`;
      map.set(date, {
        date,
        totalTasks: item.t,
        completedTasks: item.c,
        skippedTasks: item.s,
        completionRate: (item.c / item.t) * 100,
        isPerfect: item.p === 1
      });
    });
    
    return map;
  }
}
```

### 5. パフォーマンス最適化戦略

#### Virtual DOM風の差分更新

```typescript
class GrassGridOptimizer {
  private previousState: Map<string, string> = new Map();
  
  updateGrid(newData: Map<string, DailyProgress>, cells: Map<string, HTMLElement>): void {
    const updates: Array<{ date: string; color: string; element: HTMLElement }> = [];
    
    // 差分を検出
    newData.forEach((progress, date) => {
      const newColor = this.getColorForProgress(progress);
      const oldColor = this.previousState.get(date);
      
      if (newColor !== oldColor) {
        const element = cells.get(date);
        if (element) {
          updates.push({ date, color: newColor, element });
        }
      }
    });
    
    // バッチで更新
    requestAnimationFrame(() => {
      updates.forEach(({ date, color, element }) => {
        this.updateCell(element, color);
        this.previousState.set(date, color);
      });
    });
  }
}
```

#### メモリ使用量の最適化

```typescript
class MemoryOptimizer {
  // WeakMapを使用してガベージコレクションを促進
  private cellMetadata = new WeakMap<HTMLElement, CellMetadata>();
  
  // 非表示時のクリーンアップ
  onHide(): void {
    // DOMから削除してメモリを解放
    this.gridContainer.innerHTML = '';
    this.cells.clear();
  }
  
  // 再表示時の再構築
  onShow(): void {
    this.renderInitialGrid();
  }
}
```

### 6. エラーハンドリングとリカバリー

```typescript
class ErrorHandler {
  static async safeExecute<T>(
    operation: () => Promise<T>,
    fallback: T,
    errorMessage: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      console.error(`TaskChute GitHub Grass: ${errorMessage}`, error);
      new Notice(`エラーが発生しました: ${errorMessage}`);
      return fallback;
    }
  }
  
  // データ破損時のリカバリー
  static async recoverCorruptedData(plugin: Plugin): Promise<ProgressData> {
    console.warn('TaskChute: 進捗データが破損しています。リセットします。');
    const freshData: ProgressData = {
      dailyProgress: {},
      lastUpdated: new Date().toISOString()
    };
    await plugin.saveData({ ...await plugin.loadData(), progressHistory: freshData });
    return freshData;
  }
}
```

### 7. デバッグとロギング

```typescript
class DebugLogger {
  private static DEBUG = false; // 本番環境ではfalse
  
  static log(component: string, message: string, data?: any): void {
    if (!this.DEBUG) return;
    
    const timestamp = new Date().toISOString();
    console.log(`[TaskChute Grass] [${timestamp}] [${component}] ${message}`, data || '');
  }
  
  static startTimer(label: string): void {
    if (!this.DEBUG) return;
    console.time(`[TaskChute Grass] ${label}`);
  }
  
  static endTimer(label: string): void {
    if (!this.DEBUG) return;
    console.timeEnd(`[TaskChute Grass] ${label}`);
  }
}
```

### 8. テスト戦略

#### ユニットテスト例

```javascript
// __tests__/github-grass.test.js
describe('GitHubGrassComponent', () => {
  let component;
  let mockPlugin;
  let mockProgressManager;
  
  beforeEach(() => {
    mockPlugin = createMockPlugin();
    mockProgressManager = createMockProgressManager();
    component = new GitHubGrassComponent(mockPlugin, mockProgressManager, document.body);
  });
  
  describe('色の計算', () => {
    test('タスクなしの場合はグレー', () => {
      const progress = { totalTasks: 0, completedTasks: 0 };
      expect(component.getColorForProgress(progress)).toBe('#ebedf0');
    });
    
    test('完璧な完了の場合は特別な色', () => {
      const progress = { totalTasks: 5, completedTasks: 5, isPerfect: true };
      expect(component.getColorForProgress(progress)).toBe('perfect');
    });
    
    test('部分完了の場合は完了率に応じた色', () => {
      const testCases = [
        { rate: 20, expected: '#9be9a8' },
        { rate: 40, expected: '#40c463' },
        { rate: 60, expected: '#30a14e' },
        { rate: 80, expected: '#216e39' },
      ];
      
      testCases.forEach(({ rate, expected }) => {
        const progress = { 
          totalTasks: 100, 
          completedTasks: rate,
          completionRate: rate
        };
        expect(component.getColorForProgress(progress)).toBe(expected);
      });
    });
  });
  
  describe('レスポンシブ動作', () => {
    test('幅900px以上で表示', () => {
      mockContainerWidth(1000);
      component.handleResize();
      expect(component.isVisible).toBe(true);
    });
    
    test('幅900px未満で非表示', () => {
      mockContainerWidth(800);
      component.handleResize();
      expect(component.isVisible).toBe(false);
    });
  });
});
```

## 実装チェックリスト

### フェーズ1: 基礎実装
- [ ] ProgressHistoryManagerの実装
- [ ] データ保存・読み込み機能
- [ ] 基本的なグリッド表示
- [ ] 色分けロジック
- [ ] レスポンシブ対応

### フェーズ2: 統合とUI
- [ ] TaskChuteViewとの統合
- [ ] リアルタイム更新
- [ ] アニメーション効果
- [ ] ツールチップ表示
- [ ] おめでとうモーダルとの連携

### フェーズ3: 最適化とテスト
- [ ] パフォーマンス最適化
- [ ] メモリ使用量の最適化
- [ ] エラーハンドリング
- [ ] ユニットテスト
- [ ] 統合テスト

### フェーズ4: ポリッシュ
- [ ] デバッグモード
- [ ] ユーザー設定
- [ ] ドキュメント作成
- [ ] リリース準備