// TaskChute Plus - Drag Reorder Test
// ドラッグによる並び替えの問題を再現・テストするファイル

describe("ドラッグによる並び替えテスト", () => {
  // sortTaskInstances関数を抽出してテスト
  function sortTaskInstances(taskInstances, timeSlotKeys) {
    // 時間帯グループ別にソート
    const timeSlotGroups = {}
    timeSlotKeys.forEach((key) => {
      timeSlotGroups[key] = []
    })
    timeSlotGroups["none"] = []

    // インスタンスを時間帯ごとに分類
    taskInstances.forEach((inst) => {
      const slotKey = inst.slotKey || "none"
      if (timeSlotGroups[slotKey]) {
        timeSlotGroups[slotKey].push(inst)
      }
    })

    // 各時間帯グループ内でソート（新しい状態優先ソートロジック）
    Object.keys(timeSlotGroups).forEach((slotKey) => {
      const instances = timeSlotGroups[slotKey]
      if (instances.length > 1) {
        instances.sort((a, b) => {
          // 1. 状態による優先順位（done → running → idle）
          const stateOrder = { done: 0, running: 1, idle: 2 }
          const stateA = stateOrder[a.state] ?? 3
          const stateB = stateOrder[b.state] ?? 3

          if (stateA !== stateB) {
            return stateA - stateB
          }

          // 2. 同じ状態の場合の処理
          if (a.state === "done" || a.state === "running") {
            // 完了・実行中タスクは開始時刻順
            const timeA = a.startTime ? a.startTime.getTime() : Infinity
            const timeB = b.startTime ? b.startTime.getTime() : Infinity
            return timeA - timeB
          }

          // 3. アイドルタスクの場合
          if (a.state === "idle") {
            // 自動配置タスクを先に、手動配置タスクを後に
            const isManualA = a.manuallyPositioned === true
            const isManualB = b.manuallyPositioned === true

            if (isManualA !== isManualB) {
              return isManualA ? 1 : -1
            }

            // 同じタイプ（両方自動または両方手動）の場合
            if (!isManualA && !isManualB) {
              // 自動配置タスクは時刻順
              const timeA = a.task.scheduledTime
              const timeB = b.task.scheduledTime

              if (!timeA && !timeB) return 0
              if (!timeA) return 1
              if (!timeB) return -1

              const [hourA, minuteA] = timeA.split(":").map(Number)
              const [hourB, minuteB] = timeB.split(":").map(Number)
              const minutesA = hourA * 60 + minuteA
              const minutesB = hourB * 60 + minuteB

              return minutesA - minutesB
            }

            // 手動配置タスク同士は元の順序を維持
            return 0
          }

          return 0
        })
      }
    })

    // ソート結果をtaskInstancesに反映
    let sortedInstances = []
    // 意図した順序でグループを結合する
    const slotOrder = ["none", ...timeSlotKeys]
    slotOrder.forEach((slotKey) => {
      if (timeSlotGroups[slotKey]) {
        sortedInstances.push(...timeSlotGroups[slotKey])
      }
    })
    return sortedInstances
  }

  // ドラッグ操作をシミュレート
  function simulateDragOperation(taskInstances, fromTaskTitle, toPosition) {
    // 移動対象のタスクを見つける
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
    it("手動配置されたタスクが自動配置タスクの後に配置される", () => {
      const initialTasks = [
        {
          task: { title: "Task A", scheduledTime: "8:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "8:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "8:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task D", scheduledTime: "8:15" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task E", scheduledTime: "8:20" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      // Task Bを最初に移動
      const afterDrag = simulateDragOperation([...initialTasks], "Task B", 0)

      // ソート関数を適用
      const afterSort = sortTaskInstances(afterDrag, ["8:00-12:00"])

      // 手動配置されたタスクが最後に来ることを確認
      const taskBIndex = afterSort.findIndex(
        (task) => task.task.title === "Task B",
      )
      expect(taskBIndex).toBe(4) // 最後の位置
      expect(afterSort[taskBIndex].manuallyPositioned).toBe(true)

      // 自動配置タスクが時刻順になっていることを確認
      const autoTasks = afterSort.slice(0, 4)
      expect(autoTasks.map((t) => t.task.title)).toEqual([
        "Task A",
        "Task C",
        "Task D",
        "Task E",
      ])
    })
  })

  describe("新規タスクの追加と並び替え", () => {
    it("新規タスクを手動配置した場合の順序", () => {
      const tasksWithNewTask = [
        {
          task: { title: "Task A", scheduledTime: "8:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "8:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "8:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task D", scheduledTime: "8:15" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task E", scheduledTime: "8:20" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task F", scheduledTime: "8:13" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      // 初期ソート
      const sorted = sortTaskInstances(tasksWithNewTask, ["8:00-12:00"])

      // Task Fが時刻順で正しい位置にあることを確認
      expect(sorted[3].task.title).toBe("Task F") // 8:13は4番目

      // Task Fを2番目に移動
      const afterDrag = simulateDragOperation(sorted, "Task F", 1)

      // 再度ソート
      const afterSort = sortTaskInstances(afterDrag, ["8:00-12:00"])

      // Task Fが手動配置タスクとして最後に来ることを確認
      const taskFIndex = afterSort.findIndex(
        (task) => task.task.title === "Task F",
      )
      expect(taskFIndex).toBe(5) // 最後の位置
      expect(afterSort[taskFIndex].manuallyPositioned).toBe(true)
    })
  })

  describe("複数タスクの手動配置", () => {
    it("複数の手動配置タスクが元の順序を維持", () => {
      const tasks = [
        {
          task: { title: "Task A", scheduledTime: "8:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "8:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "8:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
      ]

      // Task Cを最初に移動
      let result = simulateDragOperation([...tasks], "Task C", 0)
      // Task Bを2番目に移動
      result = simulateDragOperation(result, "Task B", 1)

      // ソート
      const sorted = sortTaskInstances(result, ["8:00-12:00"])

      // 自動配置タスクが最初、手動配置タスクが最後
      expect(sorted[0].task.title).toBe("Task A") // 自動配置
      expect(sorted[1].task.title).toBe("Task C") // 手動配置（最初に移動）
      expect(sorted[2].task.title).toBe("Task B") // 手動配置（2番目に移動）

      // 手動配置タスクの相対順序が保たれていることを確認
      const manualTasks = sorted.filter((t) => t.manuallyPositioned)
      expect(manualTasks.map((t) => t.task.title)).toEqual(["Task C", "Task B"])
    })
  })

  describe("状態混在時のソート", () => {
    it("完了済み・実行中・アイドル・手動配置の優先順位", () => {
      const mixedTasks = [
        {
          task: { title: "Task A", scheduledTime: "8:01" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "idle",
        },
        {
          task: { title: "Task B", scheduledTime: "8:05" },
          slotKey: "8:00-12:00",
          manuallyPositioned: true,
          state: "idle",
        },
        {
          task: { title: "Task C", scheduledTime: "8:10" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "running",
          startTime: new Date("2024-01-01T08:10:00"),
        },
        {
          task: { title: "Task D", scheduledTime: "8:15" },
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
          state: "done",
          startTime: new Date("2024-01-01T08:15:00"),
        },
      ]

      const sorted = sortTaskInstances(mixedTasks, ["8:00-12:00"])

      // 期待される順序: 完了 → 実行中 → アイドル（自動） → アイドル（手動）
      expect(sorted.map((t) => t.task.title)).toEqual([
        "Task D",
        "Task C",
        "Task A",
        "Task B",
      ])

      // 状態の確認
      expect(sorted[0].state).toBe("done")
      expect(sorted[1].state).toBe("running")
      expect(sorted[2].state).toBe("idle")
      expect(sorted[2].manuallyPositioned).toBe(false)
      expect(sorted[3].state).toBe("idle")
      expect(sorted[3].manuallyPositioned).toBe(true)
    })
  })
})
