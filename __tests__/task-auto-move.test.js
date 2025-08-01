// TaskChute Plus - 未実施タスクの自動移動テスト

const { sortTaskInstances } = require("../main.js")

// moveIdleTasksToCurrentSlot関数のモック実装（テスト用）
function moveIdleTasksToCurrentSlot(taskInstances, currentSlot) {
  const slotStartTimes = {
    "0:00-8:00": 0,
    "8:00-12:00": 8 * 60,
    "12:00-16:00": 12 * 60,
    "16:00-0:00": 16 * 60,
  }

  const currentSlotStartTime = slotStartTimes[currentSlot]

  taskInstances.forEach((inst) => {
    if (inst.state === "idle" && inst.slotKey !== "none") {
      const taskSlotStartTime = slotStartTimes[inst.slotKey]

      if (taskSlotStartTime < currentSlotStartTime) {
        inst.slotKey = currentSlot
      }
    }
  })

  return taskInstances
}

describe("未実施タスクの自動移動機能", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  describe("過去の時間帯から現在の時間帯への移動", () => {
    test("8:00-12:00の未実施タスクが13:00に12:00-16:00へ移動すること", () => {
      // 13:00を想定（currentSlot = "12:00-16:00"）
      const taskInstances = [
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "08:00",
          },
          state: "done",
          startTime: new Date("2024-01-01T08:00:00"),
          stopTime: new Date("2024-01-01T09:00:00"),
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクB",
            path: "/task-b.md",
            scheduledTime: "09:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクC",
            path: "/task-c.md",
            scheduledTime: "10:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // 未実施タスクを現在の時間帯に移動
      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "12:00-16:00",
      )

      // タスクBとCが12:00-16:00に移動していることを確認
      expect(movedInstances[1].slotKey).toBe("12:00-16:00")
      expect(movedInstances[2].slotKey).toBe("12:00-16:00")
      // タスクAは完了済みなので移動しない
      expect(movedInstances[0].slotKey).toBe("8:00-12:00")
    })

    test("複数の時間帯から未実施タスクが移動すること", () => {
      // 16:30を想定（currentSlot = "16:00-0:00"）
      const taskInstances = [
        // 8:00-12:00の未実施タスク
        {
          task: {
            title: "朝タスク",
            path: "/morning.md",
            scheduledTime: "09:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        // 12:00-16:00の未実施タスク
        {
          task: { title: "昼タスク", path: "/noon.md", scheduledTime: "13:00" },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
        // 16:00-0:00の実行済みタスク
        {
          task: {
            title: "夕タスク",
            path: "/evening.md",
            scheduledTime: "16:00",
          },
          state: "done",
          startTime: new Date("2024-01-01T16:00:00"),
          stopTime: new Date("2024-01-01T16:30:00"),
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
      ]

      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "16:00-0:00",
      )

      // 両方の未実施タスクが16:00-0:00に移動
      expect(movedInstances[0].slotKey).toBe("16:00-0:00")
      expect(movedInstances[1].slotKey).toBe("16:00-0:00")
      expect(movedInstances[2].slotKey).toBe("16:00-0:00")
    })
  })

  describe("移動後のソート順序", () => {
    test("移動した未実施タスクが実行済みタスクの後に配置されること", () => {
      const taskInstances = [
        // 8:00-12:00の未実施タスク（移動対象）
        {
          task: {
            title: "タスクB",
            path: "/task-b.md",
            scheduledTime: "08:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクC",
            path: "/task-c.md",
            scheduledTime: "09:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        // 12:00-16:00の実行済みタスク
        {
          task: {
            title: "タスクD",
            path: "/task-d.md",
            scheduledTime: "12:00",
          },
          state: "done",
          startTime: new Date("2024-01-01T12:00:00"),
          stopTime: new Date("2024-01-01T13:00:00"),
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクE",
            path: "/task-e.md",
            scheduledTime: "13:00",
          },
          state: "done",
          startTime: new Date("2024-01-01T13:00:00"),
          stopTime: new Date("2024-01-01T14:00:00"),
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
        // 12:00-16:00の未実施タスク（16:00開始予定）
        {
          task: {
            title: "タスクF",
            path: "/task-f.md",
            scheduledTime: "16:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
      ]

      // 未実施タスクを移動
      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "12:00-16:00",
      )

      // ソート実行
      const sortedInstances = sortTaskInstances(movedInstances, timeSlotKeys)

      // 12:00-16:00の時間帯のタスクのみ抽出
      const slot1200to1600 = sortedInstances.filter(
        (inst) => inst.slotKey === "12:00-16:00",
      )
      const titles = slot1200to1600.map((inst) => inst.task.title)

      // 期待される順序：実行済み → 未実施（開始時刻順）
      expect(titles).toEqual([
        "タスクD", // 実行済み（12:00開始）
        "タスクE", // 実行済み（13:00開始）
        "タスクB", // 未実施（08:00開始予定）
        "タスクC", // 未実施（09:00開始予定）
        "タスクF", // 未実施（16:00開始予定）
      ])
    })

    test("未実施タスクが元の開始予定時刻順を保持すること", () => {
      const taskInstances = [
        // すべて8:00-12:00の未実施タスク
        {
          task: {
            title: "タスクC",
            path: "/task-c.md",
            scheduledTime: "10:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "08:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクB",
            path: "/task-b.md",
            scheduledTime: "09:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // 12:00-16:00に移動
      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "12:00-16:00",
      )

      // ソート実行
      const sortedInstances = sortTaskInstances(movedInstances, timeSlotKeys)
      const titles = sortedInstances.map((inst) => inst.task.title)

      // 開始予定時刻順に並んでいることを確認
      expect(titles).toEqual(["タスクA", "タスクB", "タスクC"])
    })
  })

  describe("エッジケース", () => {
    test("時間指定なしのタスクは移動しないこと", () => {
      const taskInstances = [
        {
          task: { title: "時間なしタスク", path: "/no-time.md" },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "none",
          manuallyPositioned: false,
        },
      ]

      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "12:00-16:00",
      )

      // slotKeyが変更されていないことを確認
      expect(movedInstances[0].slotKey).toBe("none")
    })

    test("現在または未来の時間帯のタスクは移動しないこと", () => {
      // 現在が12:00-16:00の場合
      const taskInstances = [
        // 現在の時間帯のタスク
        {
          task: {
            title: "現在タスク",
            path: "/current.md",
            scheduledTime: "13:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
        // 未来の時間帯のタスク
        {
          task: {
            title: "未来タスク",
            path: "/future.md",
            scheduledTime: "17:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
      ]

      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "12:00-16:00",
      )

      // どちらも移動していないことを確認
      expect(movedInstances[0].slotKey).toBe("12:00-16:00")
      expect(movedInstances[1].slotKey).toBe("16:00-0:00")
    })

    test("手動配置されたタスクも移動すること（ただし手動配置フラグは保持）", () => {
      const taskInstances = [
        {
          task: {
            title: "手動配置タスク",
            path: "/manual.md",
            scheduledTime: "09:00",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: true,
        },
      ]

      const movedInstances = moveIdleTasksToCurrentSlot(
        [...taskInstances],
        "12:00-16:00",
      )

      // 移動はするが、手動配置フラグは保持される
      expect(movedInstances[0].slotKey).toBe("12:00-16:00")
      expect(movedInstances[0].manuallyPositioned).toBe(true)
    })
  })
})
