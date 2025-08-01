const { sortTaskInstances } = require("../main.js")

describe("改善されたソート関数のテスト", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  // ドラッグ操作をシミュレート
  function simulateDragOperation(taskInstances, fromTaskTitle, toPosition) {
    const taskToMove = taskInstances.find(
      (inst) => inst.task.title === fromTaskTitle,
    )
    if (!taskToMove) return taskInstances

    // 手動配置フラグを設定
    taskToMove.manuallyPositioned = true

    // 配列から一度削除
    const filtered = taskInstances.filter(
      (inst) => inst.task.title !== fromTaskTitle,
    )

    // 指定位置に挿入
    filtered.splice(toPosition, 0, taskToMove)

    return filtered
  }

  describe("基本的なドラッグ操作", () => {
    test("手動配置されたタスクが自動配置タスクの後に配置される", () => {
      const initialTasks = [
        {
          task: { title: "Task A", scheduledTime: "08:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "08:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "08:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task D", scheduledTime: "08:15" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task E", scheduledTime: "08:20" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      // Task Bを手動で移動（ドラッグをシミュレート）
      const afterDrag = simulateDragOperation([...initialTasks], "Task B", 0)

      // ソートを適用
      const afterSort = sortTaskInstances(afterDrag, timeSlotKeys)
      const sortedTitles = afterSort.map((task) => task.task.title)

      // 新しいソートロジック：手動配置タスクは元の位置を保持
      expect(sortedTitles).toEqual([
        "Task B", // 手動配置（元の位置を保持）
        "Task A", // 08:01 (自動)
        "Task C", // 08:10 (自動)
        "Task D", // 08:15 (自動)
        "Task E", // 08:20 (自動)
      ])
    })
  })

  describe("新規タスクの追加と並び替え", () => {
    test("新規タスクを手動配置した場合の順序", () => {
      const tasksWithNewTask = [
        {
          task: { title: "Task A", scheduledTime: "08:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "08:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "08:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task D", scheduledTime: "08:15" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task E", scheduledTime: "08:20" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task F", scheduledTime: "08:13" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      // 初期ソート（時刻順）
      const sorted = sortTaskInstances(tasksWithNewTask, timeSlotKeys)
      const sortedTitles = sorted.map((task) => task.task.title)

      expect(sortedTitles).toEqual([
        "Task A", // 08:01
        "Task B", // 08:05
        "Task C", // 08:10
        "Task F", // 08:13
        "Task D", // 08:15
        "Task E", // 08:20
      ])

      // Task Fを手動で移動
      const afterDrag = simulateDragOperation(sorted, "Task F", 1)
      const afterSort = sortTaskInstances(afterDrag, timeSlotKeys)
      const finalTitles = afterSort.map((task) => task.task.title)

      // 手動配置タスクは元の位置を保持
      expect(finalTitles).toEqual([
        "Task A", // 08:01 (自動)
        "Task F", // 手動配置（2番目の位置を保持）
        "Task B", // 08:05 (自動)
        "Task C", // 08:10 (自動)
        "Task D", // 08:15 (自動)
        "Task E", // 08:20 (自動)
      ])
    })
  })

  describe("複数タスクの手動配置", () => {
    test("複数の手動配置タスクが元の順序を維持", () => {
      const tasks = [
        {
          task: { title: "Task A", scheduledTime: "08:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "08:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "08:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task D", scheduledTime: "08:15" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task E", scheduledTime: "08:20" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      // Task BとTask Eを手動配置
      let result = [...tasks]
      result = simulateDragOperation(result, "Task B", 0)
      result = simulateDragOperation(result, "Task E", 1)

      const sorted = sortTaskInstances(result, timeSlotKeys)
      const sortedTitles = sorted.map((task) => task.task.title)

      // 手動配置タスクは元の位置を保持
      expect(sortedTitles).toEqual([
        "Task B", // 手動配置（1番目の位置を保持）
        "Task E", // 手動配置（2番目の位置を保持）
        "Task A", // 08:01 (自動)
        "Task C", // 08:10 (自動)
        "Task D", // 08:15 (自動)
      ])
    })
  })

  describe("状態混在時のソート", () => {
    test("完了済み・実行中・アイドル・手動配置の優先順位", () => {
      const tasks = [
        {
          task: { title: "Manual Task", scheduledTime: null },
          slotKey: "8:00-12:00",
          manuallyPositioned: true,
          state: "idle",
        },
        {
          task: { title: "Done Task", scheduledTime: "08:00" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "done",
          startTime: new Date("2024-01-15T08:00:00"),
          stopTime: new Date("2024-01-15T08:30:00"),
        },
        {
          task: { title: "Running Task", scheduledTime: "08:30" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "running",
          startTime: new Date("2024-01-15T08:30:00"),
        },
        {
          task: { title: "Idle Task", scheduledTime: "09:00" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      const sorted = sortTaskInstances(tasks, timeSlotKeys)
      const sortedTitles = sorted.map((task) => task.task.title)

      // 状態優先順位：done → running → idle（手動配置は元の位置を保持）
      expect(sortedTitles).toEqual([
        "Done Task", // done
        "Running Task", // running
        "Manual Task", // idle (手動配置、元の位置を保持)
        "Idle Task", // idle (自動)
      ])
    })
  })
})
