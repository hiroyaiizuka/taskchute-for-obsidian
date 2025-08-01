# タスクの並び替え仕様書 v2.1

## 概要

TaskChute Plusにおけるタスクの並び替え機能の詳細仕様を定義します。
本仕様書は、順序番号（order）ベースのシンプルな実装方針を採用しています。

## 改訂履歴
- v1.0: 初版（manuallyPositioned + savedPosition方式）
- v2.0: 順序番号（order）方式への全面改訂
- v2.1: task-sort-simplification実装完了（2025-01-23）

## 基本概念

### タスクの種類
- **ルーチンタスク**: `frontmatter.routine = true`、定期的に実行されるタスク
- **非ルーチンタスク**: `frontmatter.routine = false`または未設定、単発のタスク

### タスクの状態
- **idle**: 未実行状態
- **running**: 実行中状態
- **done**: 完了状態

### 時間帯スロット
- **0:00-8:00**: 深夜・早朝
- **8:00-12:00**: 午前
- **12:00-16:00**: 午後
- **16:00-0:00**: 夕方・夜間
- **none**: 時間指定なし

## 新しいデータ構造

### タスクインスタンス
```javascript
{
  task: taskObj,              // タスクオブジェクト
  state: "idle|running|done", // タスクの状態
  slotKey: "8:00-12:00",     // 時間帯スロット
  order: 100,                // 順序番号（整数）
  startTime: null,           // 開始時刻
  stopTime: null,            // 終了時刻
  instanceId: "unique-id"    // 一意のインスタンスID
}
```

### localStorage管理
```javascript
// 日付ごとのタスク順序を1つのキーで管理
"taskchute-orders-2024-01-15" = {
  "task-path-1": { slot: "8:00-12:00", order: 100 },
  "task-path-2": { slot: "8:00-12:00", order: 200 },
  "task-path-3": { slot: "12:00-16:00", order: 100 }
}
```

## 並び替えの基本ルール

### 1. ソート処理（超シンプル化）

```javascript
function sortTaskInstances(taskInstances) {
  return taskInstances.sort((a, b) => {
    // 1. 状態優先: done → running → idle
    const stateOrder = { done: 0, running: 1, idle: 2 }
    if (a.state !== b.state) {
      return stateOrder[a.state] - stateOrder[b.state]
    }
    
    // 2. 同じ状態内では順序番号で並び替え
    return a.order - b.order
  })
}
```

### 2. 1日の開始時の初期配置

**実行タイミング**: 日付が変わったとき、アプリ起動時

```javascript
function initializeDailyTasks(date) {
  const routineTasks = getRoutineTasksForDate(date)
  
  // 時間帯ごとにグループ化
  const slotGroups = groupByTimeSlot(routineTasks)
  
  // 各時間帯内で開始時刻順に順序番号を付与
  Object.entries(slotGroups).forEach(([slotKey, tasks]) => {
    tasks
      .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))
      .forEach((task, index) => {
        task.order = (index + 1) * 100  // 100, 200, 300...
        task.slotKey = slotKey
      })
  })
}
```

### 3. 手動移動の処理

```javascript
function moveTask(taskId, targetIndex, targetSlot) {
  const task = findTask(taskId)
  const slotTasks = getTasksInSlot(targetSlot)
    .filter(t => t.state === task.state)  // 同じ状態のタスクのみ
  
  // 新しい順序番号を計算
  const newOrder = calculateNewOrder(targetIndex, slotTasks)
  
  // タスクを更新
  task.slotKey = targetSlot
  task.order = newOrder
  
  // localStorageに保存
  saveTaskOrder(task.path, targetSlot, newOrder)
  
  // 必要に応じて順序番号を正規化
  checkAndNormalizeOrders(slotTasks)
}

function calculateNewOrder(targetIndex, taskInstances) {
  if (taskInstances.length === 0) {
    return 100
  }
  
  if (targetIndex === 0) {
    // 一番上に移動
    return taskInstances[0].order - 100
  }
  
  if (targetIndex >= taskInstances.length) {
    // 一番下に移動
    return taskInstances[taskInstances.length - 1].order + 100
  }
  
  // 間に挿入
  const prevOrder = taskInstances[targetIndex - 1].order
  const nextOrder = taskInstances[targetIndex].order
  const gap = nextOrder - prevOrder
  
  if (gap <= 1) {
    // 隙間がない場合は全体を正規化してから再計算
    normalizeOrders(taskInstances)
    return (targetIndex + 0.5) * 100
  }
  
  // 整数の中間値を使用
  return Math.floor((prevOrder + nextOrder) / 2)
}
```

### 4. 新規タスクの追加

```javascript
function createNewTask(taskObj) {
  const currentSlot = getCurrentTimeSlot()
  const slotTasks = getTasksInSlot(currentSlot)
    .filter(t => t.state === "idle")  // 未実行タスクのみ
  
  // 最後の順序番号 + 100
  const maxOrder = Math.max(...slotTasks.map(t => t.order), 0)
  
  return {
    task: taskObj,
    state: "idle",
    slotKey: currentSlot,      // 現在の時間帯に配置
    order: maxOrder + 100,     // 最後に追加
    startTime: null,
    stopTime: null,
    instanceId: generateInstanceId()
  }
}
```

### 5. タスク実行時の移動

```javascript
function startTask(taskId) {
  const task = findTask(taskId)
  const currentSlot = getCurrentTimeSlot()
  
  if (task.slotKey !== currentSlot) {
    // 別の時間帯から実行する場合
    const currentSlotDoneTasks = getTasksInSlot(currentSlot)
      .filter(t => t.state === "done")
    
    // 実行済みタスクの最後の順序番号を取得
    const maxDoneOrder = Math.max(...currentSlotDoneTasks.map(t => t.order), 0)
    
    // 移動して実行開始
    task.slotKey = currentSlot
    task.order = maxDoneOrder + 50  // 実行済みの直後に配置
  }
  
  task.state = "running"
  task.startTime = new Date()
}
```

### 6. 順序番号の正規化

```javascript
function normalizeOrders(taskInstances) {
  // 同じ時間帯・状態のタスクをグループ化
  const groups = {}
  taskInstances.forEach(task => {
    const key = `${task.slotKey}-${task.state}`
    if (!groups[key]) groups[key] = []
    groups[key].push(task)
  })
  
  // 各グループ内で順序番号を再割り当て
  Object.values(groups).forEach(group => {
    group
      .sort((a, b) => a.order - b.order)
      .forEach((task, index) => {
        task.order = (index + 1) * 100  // 100, 200, 300...
      })
  })
}

// 正規化が必要かチェック
function checkAndNormalizeOrders(taskInstances) {
  const orders = taskInstances.map(t => t.order).sort((a, b) => a - b)
  
  for (let i = 1; i < orders.length; i++) {
    const gap = orders[i] - orders[i - 1]
    if (gap < 10) {  // 隙間が10未満になったら正規化
      normalizeOrders(taskInstances)
      break
    }
  }
}
```

## 移動制約

### 実行済みタスクより上への移動禁止
```javascript
function canMoveToIndex(task, targetIndex, targetSlotTasks) {
  if (task.state !== "idle") return true  // 未実行以外は制約なし
  
  // ターゲット位置より上に実行済みタスクがあるかチェック
  const tasksAbove = targetSlotTasks.slice(0, targetIndex)
  const hasDoneTaskAbove = tasksAbove.some(t => t.state === "done")
  
  return !hasDoneTaskAbove
}
```

## localStorage管理の詳細

### 保存形式
```javascript
// 日付ごとに1つのキーで管理
const storageKey = `taskchute-orders-${dateStr}`
const orders = {
  "path/to/task1.md": { slot: "8:00-12:00", order: 100 },
  "path/to/task2.md": { slot: "8:00-12:00", order: 200 },
  "path/to/task3.md": { slot: "12:00-16:00", order: 100 }
}
localStorage.setItem(storageKey, JSON.stringify(orders))
```

### クリーンアップ処理
```javascript
function cleanupOldOrders() {
  const today = new Date()
  const keys = Object.keys(localStorage)
  
  keys.forEach(key => {
    if (key.startsWith("taskchute-orders-")) {
      const dateStr = key.replace("taskchute-orders-", "")
      const keyDate = new Date(dateStr)
      const daysDiff = (today - keyDate) / (1000 * 60 * 60 * 24)
      
      if (daysDiff > 7) {  // 7日以上前のデータは削除
        localStorage.removeItem(key)
      }
    }
  })
}
```

## パフォーマンス最適化

### ソート処理の最適化
- 状態と順序番号の2つの比較のみ（O(n log n)）
- 複雑な条件分岐を排除
- 整数比較のみで高速

### localStorage アクセスの最適化
- 日付ごとに1つのキーで一括管理
- 個別のタスクごとのアクセスを削減
- 起動時に一度だけ読み込み

### メモリ使用量の削減
- `manuallyPositioned`フラグを削除
- `savedPosition`フィールドを削除
- 1つの`order`フィールドのみ

## 実装時の注意点

### 1. 順序番号の管理
- 初期値は100刻み（拡張の余地を残す）
- 最小隙間が10未満になったら正規化
- 整数のみ使用（浮動小数点の精度問題を回避）

### 2. 状態遷移時の処理
- タスク実行時は現在の時間帯に移動
- 完了時は順序番号を保持
- キャンセル時は元の位置に戻す

### 3. エッジケース
- 空の時間帯への移動
- 同じ順序番号の競合
- 日付をまたぐ処理

## 移行計画

### フェーズ1: データ構造の追加
1. `order`フィールドを追加
2. 既存の`manuallyPositioned`と並行運用

### フェーズ2: ロジックの切り替え
1. ソート処理を新方式に変更
2. ドラッグ&ドロップを新方式に対応

### フェーズ3: 古いデータの削除
1. `manuallyPositioned`フィールドを削除
2. `savedPosition`フィールドを削除
3. 古いlocalStorageキーをクリーンアップ

## まとめ

この新しい実装方針により：
- **シンプル**: 順序番号1つで位置を管理
- **高速**: 単純な整数比較のみ
- **堅牢**: 状態管理が明確
- **拡張性**: 新機能の追加が容易

従来の複雑な条件分岐とフラグ管理から解放され、バグの少ない安定したシステムを実現できます。

## 実装状況（v2.1）

### 完了した実装
1. **manuallyPositionedフラグの完全削除**
   - orderベースの単一管理方式に統一
   
2. **新しいヘルパー関数の実装**
   - `loadSavedOrders()`: 保存されたorder情報の読み込み
   - `saveTaskOrders()`: order情報の保存
   - `determineSlotKey()`: 優先順位に基づくslotKey決定
   - `calculateSimpleOrder()`: シンプルなorder計算
   - `sortByOrder()`: 統一されたソート関数
   - `moveInstanceToSlotSimple()`: 簡素化されたタスク移動

3. **バグ修正**
   - scheduledTimeがsavedOrderを上書きする問題を解決
   - 優先順位を明確化：保存データ > scheduledTime > デフォルト

4. **テストカバレッジ**
   - order-based-sort.test.js: 9テスト全て合格
   - task-persistence.test.js: 位置永続化の検証

### 今後の推奨アクション
1. useOrderBasedSortフラグをデフォルトで有効化
2. 旧実装の段階的削除（sortTaskInstances、resetManualPositioning等）
3. パフォーマンス最適化（DOM差分更新、バッチ処理） 