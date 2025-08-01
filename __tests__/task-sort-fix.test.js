const { sortTaskInstances } = require("../main.js")

describe("タスクソート修正の検証", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  describe("手動配置タスクと自動配置タスクの混在時のソート", () => {
    test("手動配置タスクが元の位置を保持すること", () => {
      const taskInstances = [
        {
          task: { title: "タスクA", scheduledTime: "08:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB", scheduledTime: "10:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: true, // 手動配置
        },
        {
          task: { title: "タスクC", scheduledTime: "09:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      const sorted = sortTaskInstances(taskInstances, timeSlotKeys)
      const titles = sorted.map((inst) => inst.task.title)

      // 手動配置タスクBは元の位置（2番目）を保持
      // 自動配置タスクA,Cは時刻順でソート
      expect(titles).toEqual(["タスクA", "タスクB", "タスクC"])
    })

    test("新規ルーチンタスクが正しい時刻順で配置されること", () => {
      const taskInstances = [
        {
          task: { title: "既存タスク1", scheduledTime: "08:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "既存タスク2", scheduledTime: "09:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "既存タスク3", scheduledTime: "10:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "新規タスク", scheduledTime: "08:30" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false, // 自動配置
        },
      ]

      const sorted = sortTaskInstances(taskInstances, timeSlotKeys)
      const titles = sorted.map((inst) => inst.task.title)

      // 新規タスクが時刻順の正しい位置に配置される
      expect(titles).toEqual([
        "既存タスク1", // 08:00
        "新規タスク", // 08:30
        "既存タスク2", // 09:00
        "既存タスク3", // 10:00
      ])
    })

    test("完了済み・実行中タスクが優先されること", () => {
      const taskInstances = [
        {
          task: { title: "手動配置タスク", scheduledTime: "08:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "完了タスク", scheduledTime: "09:00" },
          state: "done",
          startTime: new Date("2024-01-01T09:00:00"),
          stopTime: new Date("2024-01-01T09:30:00"),
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "実行中タスク", scheduledTime: "10:00" },
          state: "running",
          startTime: new Date("2024-01-01T10:00:00"),
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "自動配置タスク", scheduledTime: "08:30" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      const sorted = sortTaskInstances(taskInstances, timeSlotKeys)
      const titles = sorted.map((inst) => inst.task.title)

      // 状態優先：完了済み → 実行中 → アイドル
      expect(titles).toEqual([
        "完了タスク", // done
        "実行中タスク", // running
        "手動配置タスク", // idle (手動)
        "自動配置タスク", // idle (自動)
      ])
    })
  })

  describe("ドラッグ操作後の並び順保持", () => {
    test("ドラッグで移動したタスクが正しい位置に保持されること", () => {
      // 初期状態
      let taskInstances = [
        {
          task: { title: "タスクA", scheduledTime: "08:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB", scheduledTime: "09:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクC", scheduledTime: "10:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // タスクCをタスクAの後（2番目）に移動
      const taskC = taskInstances[2]
      taskInstances.splice(2, 1) // タスクCを削除
      taskInstances.splice(1, 0, taskC) // 2番目に挿入
      taskC.manuallyPositioned = true // 手動配置フラグを設定

      const sorted = sortTaskInstances(taskInstances, timeSlotKeys)
      const titles = sorted.map((inst) => inst.task.title)

      // タスクCは手動配置されたので、2番目の位置を保持
      expect(titles).toEqual(["タスクA", "タスクC", "タスクB"])
    })

    test("複数の手動配置タスクの相対順序が保持されること", () => {
      const taskInstances = [
        {
          task: { title: "タスクA", scheduledTime: "08:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB", scheduledTime: "10:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: true, // 手動で2番目に配置
        },
        {
          task: { title: "タスクC", scheduledTime: "08:30" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: true, // 手動で3番目に配置
        },
        {
          task: { title: "タスクD", scheduledTime: "09:00" },
          state: "idle",
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      const sorted = sortTaskInstances(taskInstances, timeSlotKeys)
      const titles = sorted.map((inst) => inst.task.title)

      // 手動配置タスクは元の順序を保持
      // 自動配置タスクは時刻順
      expect(titles).toEqual([
        "タスクA", // 08:00 (自動)
        "タスクB", // 手動配置（元の2番目）
        "タスクC", // 手動配置（元の3番目）
        "タスクD", // 09:00 (自動)
      ])
    })
  })
})
