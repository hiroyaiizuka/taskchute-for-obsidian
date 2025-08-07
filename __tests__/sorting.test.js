const { sortTaskInstances } = require('../main.js')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')
const moment = require("moment")

describe("TaskChuteソート関数", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  test("実行中のタスクが完了済みタスクの後（時系列順）に正しくソートされること", () => {
    // 1. テストデータの準備（3つの完了済みタスク）
    const now = moment()
    let taskInstances = [
      {
        task: { title: "タスクA", path: "/task-a.md" },
        state: "done",
        startTime: now.clone().subtract(30, "minutes").toDate(),
        stopTime: now.clone().subtract(20, "minutes").toDate(),
        slotKey: "16:00-0:00",
      },
      {
        task: { title: "タスクB", path: "/task-b.md" },
        state: "done",
        startTime: now.clone().subtract(20, "minutes").toDate(),
        stopTime: now.clone().subtract(10, "minutes").toDate(),
        slotKey: "16:00-0:00",
      },
      {
        task: { title: "タスクC", path: "/task-c.md" },
        state: "done",
        startTime: now.clone().subtract(10, "minutes").toDate(),
        stopTime: now.clone().subtract(5, "minutes").toDate(),
        slotKey: "16:00-0:00",
      },
    ]

    // 2. 新しいタスクDを開始
    const taskD_instance = {
      task: { title: "タスクD", path: "/task-d.md" },
      state: "running", // 実行中
      startTime: now.toDate(), // 現在時刻に開始
      stopTime: null,
      slotKey: "16:00-0:00",
    }
    taskInstances.push(taskD_instance)

    // 3. ソートを実行
    let sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)

    // 4. 結果を検証
    let sortedTitles = sortedInstances.map((inst) => inst.task.title)
    expect(sortedTitles).toEqual(["タスクA", "タスクB", "タスクC", "タスクD"])

    // 5. タスクDを完了させる
    taskD_instance.state = "done"
    taskD_instance.stopTime = now.clone().add(5, "minutes").toDate()

    // 6. 再度ソートを実行
    sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)

    // 7. 結果を再度検証
    sortedTitles = sortedInstances.map((inst) => inst.task.title)
    expect(sortedTitles).toEqual(["タスクA", "タスクB", "タスクC", "タスクD"])
  })

  test("アイドル状態のタスクは常に進行中タスクの後に表示されること", () => {
    // 1. テストデータの準備
    const now = moment()
    const taskInstances = [
      {
        task: { title: "完了タスク", path: "/done.md" },
        state: "done",
        startTime: now.clone().subtract(1, "hour").toDate(),
        slotKey: "16:00-0:00",
      },
      {
        task: { title: "アイドルタスク1", path: "/idle1.md" },
        state: "idle",
        startTime: null,
        slotKey: "16:00-0:00",
      },
      {
        task: { title: "実行中タスク", path: "/running.md" },
        state: "running",
        startTime: now.toDate(),
        slotKey: "16:00-0:00",
      },
      {
        task: { title: "アイドルタスク2", path: "/idle2.md" },
        state: "idle",
        startTime: null,
        slotKey: "16:00-0:00",
      },
    ]

    // 2. ソートを実行
    const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)

    // 3. 結果を検証
    const sortedTitles = sortedInstances.map((inst) => inst.task.title)
    expect(sortedTitles).toEqual([
      "完了タスク",
      "実行中タスク",
      "アイドルタスク1",
      "アイドルタスク2",
    ])
  })

  describe("ルーチンタスクの開始時刻順ソート", () => {
    test("同一時間帯スロット内でアイドル状態のルーチンタスクが開始時刻順に並ぶこと", () => {
      // バグ再現：新規ルーチンタスクが翌日以降で時刻順に並ばない問題
      const taskInstances = [
        {
          task: {
            title: "昼ごはん",
            path: "/lunch.md",
            scheduledTime: "12:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "新規タスクA",
            path: "/new-task-a.md",
            scheduledTime: "14:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "タスクB",
            path: "/task-b.md",
            scheduledTime: "13:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
      ]

      // ソートを実行
      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)

      // 開始時刻順に並んでいることを検証：12:00 → 13:00 → 14:00
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)
      expect(sortedTitles).toEqual(["昼ごはん", "タスクB", "新規タスクA"])
    })

    test("開始時刻が設定されていないタスクは最後に表示されること", () => {
      const taskInstances = [
        {
          task: {
            title: "時刻なしタスク",
            path: "/no-time.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "12時タスク",
            path: "/twelve.md",
            scheduledTime: "12:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "時刻なしタスク2",
            path: "/no-time-2.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 時刻設定済みタスクが先に、時刻なしタスクが後に表示される
      expect(sortedTitles).toEqual([
        "12時タスク",
        "時刻なしタスク",
        "時刻なしタスク2",
      ])
    })

    test("複数の時間帯スロットにまたがるルーチンタスクが正しくソートされること", () => {
      const taskInstances = [
        // 12:00-16:00スロット
        {
          task: {
            title: "14時タスク",
            path: "/fourteen.md",
            scheduledTime: "14:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "12時タスク",
            path: "/twelve.md",
            scheduledTime: "12:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        // 8:00-12:00スロット
        {
          task: {
            title: "10時タスク",
            path: "/ten.md",
            scheduledTime: "10:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
        },
        {
          task: {
            title: "9時タスク",
            path: "/nine.md",
            scheduledTime: "09:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 各スロット内で時刻順、スロット順序は定義通り
      expect(sortedTitles).toEqual([
        "9時タスク", // 8:00-12:00スロット内で09:00
        "10時タスク", // 8:00-12:00スロット内で10:00
        "12時タスク", // 12:00-16:00スロット内で12:00
        "14時タスク", // 12:00-16:00スロット内で14:00
      ])
    })

    test("実行中タスクとアイドルタスクが混在する場合の正しいソート", () => {
      const now = moment()
      const taskInstances = [
        {
          task: {
            title: "14時ルーチン",
            path: "/routine-14.md",
            scheduledTime: "14:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "実行中タスク",
            path: "/running.md",
            scheduledTime: "13:00",
            isRoutine: true,
          },
          state: "running",
          startTime: now.clone().subtract(30, "minutes").toDate(),
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "12時ルーチン",
            path: "/routine-12.md",
            scheduledTime: "12:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "12:00-16:00",
        },
        {
          task: {
            title: "完了済みタスク",
            path: "/done.md",
            scheduledTime: "12:30",
            isRoutine: true,
          },
          state: "done",
          startTime: now.clone().subtract(2, "hours").toDate(),
          stopTime: now.clone().subtract(1, "hours").toDate(),
          slotKey: "12:00-16:00",
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 進行中タスクが最初、その後アイドルタスクが時刻順
      expect(sortedTitles).toEqual([
        "完了済みタスク", // done状態（開始時刻順）
        "実行中タスク", // running状態
        "12時ルーチン", // idle状態（時刻順）
        "14時ルーチン", // idle状態（時刻順）
      ])
    })
  })
})
