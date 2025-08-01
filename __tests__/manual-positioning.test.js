const { sortTaskInstances } = require("../main.js")

describe("手動配置機能テスト", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  describe("manuallyPositionedフラグの基本動作", () => {
    test("手動配置されたタスクがアイドルタスクの最後に配置されること", () => {
      const taskInstances = [
        {
          task: {
            title: "ルーチンタスクA",
            path: "/routine-a.md",
            scheduledTime: "11:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: true, // 手動配置済み
        },
        {
          task: {
            title: "非ルーチンタスクB",
            path: "/task-b.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: false, // 自動配置
        },
        {
          task: {
            title: "非ルーチンタスクC",
            path: "/task-c.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: false, // 自動配置
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 新しいソートロジック：手動配置タスクは元の位置を保持
      expect(sortedTitles).toEqual([
        "ルーチンタスクA", // 手動配置（元の位置を保持）
        "非ルーチンタスクB",
        "非ルーチンタスクC",
      ])
    })

    test("複数の手動配置タスクの順序が維持されること", () => {
      const taskInstances = [
        {
          task: {
            title: "手動配置タスク1",
            path: "/manual1.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: true,
        },
        {
          task: {
            title: "自動配置タスク",
            path: "/auto.md",
            scheduledTime: "17:00",
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "手動配置タスク2",
            path: "/manual2.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: true,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 新しいソートロジック：手動配置タスクは元の順序を維持
      expect(sortedTitles).toEqual([
        "手動配置タスク1", // 手動配置（元の1番目）
        "自動配置タスク",
        "手動配置タスク2", // 手動配置（元の3番目）
      ])
    })

    test("手動配置フラグが未定義の場合はfalse扱いになること", () => {
      const taskInstances = [
        {
          task: {
            title: "フラグ未定義タスク",
            path: "/undefined.md",
            scheduledTime: "10:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          // manuallyPositioned未定義
        },
        {
          task: {
            title: "手動配置タスク",
            path: "/manual.md",
            scheduledTime: "12:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: true,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 未定義は自動配置扱いで先に表示
      expect(sortedTitles).toEqual(["フラグ未定義タスク", "手動配置タスク"])
    })
  })

  describe("状態優先ソートとの組み合わせ", () => {
    test("完了済み・実行中タスクが手動配置タスクより優先されること", () => {
      const taskInstances = [
        {
          task: {
            title: "手動配置タスク",
            path: "/manual.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: true,
        },
        {
          task: {
            title: "完了済みタスク",
            path: "/done.md",
            scheduledTime: "17:00",
            isRoutine: false,
          },
          state: "done",
          startTime: new Date("2024-01-15T17:00:00"),
          stopTime: new Date("2024-01-15T17:30:00"),
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "実行中タスク",
            path: "/running.md",
            scheduledTime: "18:00",
            isRoutine: false,
          },
          state: "running",
          startTime: new Date("2024-01-15T18:00:00"),
          stopTime: null,
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 状態優先：完了済み → 実行中 → アイドル（手動配置）
      expect(sortedTitles).toEqual([
        "完了済みタスク",
        "実行中タスク",
        "手動配置タスク",
      ])
    })

    test("自動ソート機能が既存のルーチンタスクで正常に動作すること", () => {
      // 手動配置されていないルーチンタスクは従来通りscheduledTime順
      const taskInstances = [
        {
          task: {
            title: "ルーチンタスクC",
            path: "/routine-c.md",
            scheduledTime: "14:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "ルーチンタスクA",
            path: "/routine-a.md",
            scheduledTime: "12:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "ルーチンタスクB",
            path: "/routine-b.md",
            scheduledTime: "13:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
          manuallyPositioned: false,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // scheduledTime順で正しくソートされる
      expect(sortedTitles).toEqual([
        "ルーチンタスクA", // 12:00
        "ルーチンタスクB", // 13:00
        "ルーチンタスクC", // 14:00
      ])
    })
  })

  describe("混合シナリオ", () => {
    test("実行中・完了済み・アイドル・手動配置タスクが混在する場合の順序", () => {
      const taskInstances = [
        {
          task: { title: "手動配置タスク", path: "/manual.md" },
          state: "idle",
          slotKey: "16:00-0:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "完了済みタスク", path: "/done.md" },
          state: "done",
          startTime: new Date("2024-01-15T17:00:00"),
          stopTime: new Date("2024-01-15T17:30:00"),
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "実行中タスク", path: "/running.md" },
          state: "running",
          startTime: new Date("2024-01-15T18:00:00"),
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "アイドルタスク",
            path: "/idle.md",
            scheduledTime: "19:00",
          },
          state: "idle",
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 期待される順序: 状態優先（完了済み → 実行中 → アイドル）手動配置は元の位置を保持
      expect(sortedTitles).toEqual([
        "完了済みタスク",
        "実行中タスク",
        "手動配置タスク", // 手動配置（元の位置を保持）
        "アイドルタスク",
      ])
    })

    test("異なる時間スロットでの動作確認", () => {
      const taskInstances = [
        // 8:00-12:00スロット
        {
          task: { title: "朝の手動タスク", path: "/morning-manual.md" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: true,
        },
        {
          task: {
            title: "朝の自動タスク",
            path: "/morning-auto.md",
            scheduledTime: "09:00",
          },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        // 16:00-0:00スロット
        {
          task: {
            title: "夜の自動タスク",
            path: "/evening-auto.md",
            scheduledTime: "18:00",
          },
          state: "idle",
          slotKey: "16:00-0:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "夜の手動タスク", path: "/evening-manual.md" },
          state: "idle",
          slotKey: "16:00-0:00",
          manuallyPositioned: true,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 各スロット内で手動配置タスクは元の位置を保持
      expect(sortedTitles).toEqual([
        "朝の手動タスク", // 手動配置（元の位置を保持）
        "朝の自動タスク",
        "夜の自動タスク",
        "夜の手動タスク", // 手動配置（元の位置を保持）
      ])
    })
  })
})
