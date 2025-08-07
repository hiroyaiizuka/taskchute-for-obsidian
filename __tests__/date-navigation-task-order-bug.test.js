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

describe("日付移動後のタスク順序変更バグ", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  describe("修正後の正しい動作", () => {
    test("【修正確認】状態優先でソートされ、手動配置タスクが正しい位置に配置される", () => {
      // 修正後の動作：
      // 1. 状態による優先順位（done → running → idle）
      // 2. アイドルタスク内では、自動配置が先、手動配置が後

      const instances = [
        // 新規タスクC（手動配置、配列の最初）
        {
          task: {
            title: "タスクC",
            path: "/task-c.md",
            scheduledTime: null,
            isRoutine: false,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "0:00-8:00",
          manuallyPositioned: true,
        },
        // タスクA（実行済み）
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "06:00",
            isRoutine: false,
          },
          state: "done",
          startTime: new Date("2024-01-15T06:00:00"),
          stopTime: new Date("2024-01-15T06:30:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        // タスクB（再生中）
        {
          task: {
            title: "タスクB",
            path: "/task-b.md",
            scheduledTime: "06:30",
            isRoutine: false,
          },
          state: "running",
          startTime: new Date("2024-01-15T06:30:00"),
          stopTime: null,
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
      ]

      console.log("元の配列順序:")
      instances.forEach((inst, index) => {
        console.log(
          `  ${index + 1}. ${inst.task.title} (${inst.state}, manual: ${
            inst.manuallyPositioned
          })`,
        )
      })

      // ソートを実行
      const sortedInstances = sortTaskInstances(instances, timeSlotKeys)

      console.log("\nソート後の順序:")
      sortedInstances.forEach((inst, index) => {
        console.log(
          `  ${index + 1}. ${inst.task.title} (${inst.state}, manual: ${
            inst.manuallyPositioned
          })`,
        )
      })

      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 修正後の期待される順序：完了済み → 実行中 → アイドル（手動配置）
      expect(sortedTitles).toEqual(["タスクA", "タスクB", "タスクC"])

      console.log(
        "\n✅ 修正により、手動配置タスクが正しい位置に配置されるようになりました",
      )
    })

    test("【詳細分析】状態優先ソートの動作確認", () => {
      const instances = [
        {
          task: { title: "タスクC", scheduledTime: null },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "タスクA", scheduledTime: "06:00" },
          state: "done",
          startTime: new Date("2024-01-15T06:00:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB", scheduledTime: "06:30" },
          state: "running",
          startTime: new Date("2024-01-15T06:30:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
      ]

      console.log("\n=== 状態優先ソートの詳細分析 ===")

      // sortTaskInstances内の処理を模倣
      const sorted = [...instances].sort((a, b) => {
        // 1. 状態による優先順位
        const stateOrder = { done: 0, running: 1, idle: 2 }
        const stateA = stateOrder[a.state] ?? 3
        const stateB = stateOrder[b.state] ?? 3

        console.log(
          `比較: ${a.task.title}(${a.state}:${stateA}) vs ${b.task.title}(${b.state}:${stateB})`,
        )

        if (stateA !== stateB) {
          const result = stateA - stateB
          console.log(
            `  → 状態が異なる: ${
              result < 0 ? a.task.title : b.task.title
            } が先`,
          )
          return result
        }

        console.log(`  → 状態が同じ`)
        return 0
      })

      console.log(
        "\n最終結果:",
        sorted.map((inst) => inst.task.title),
      )

      // 正しい順序：状態優先
      expect(sorted[0].task.title).toBe("タスクA") // done
      expect(sorted[1].task.title).toBe("タスクB") // running
      expect(sorted[2].task.title).toBe("タスクC") // idle
    })

    test("【実際のシナリオ】日付移動後も正しい順序が保たれる", () => {
      // 実際のloadTasksでは、タスクの読み込み順序が変わる可能性がある
      // 修正により、読み込み順序に関わらず正しくソートされる

      console.log("\n=== 実際のシナリオ（修正後） ===")

      // 初日：正しい順序
      console.log("1. 初日（タスク追加直後）:")
      const day1Instances = [
        {
          task: { title: "タスクA" },
          state: "done",
          startTime: new Date(),
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB" },
          state: "running",
          startTime: new Date(),
          manuallyPositioned: false,
        },
        { task: { title: "タスクC" }, state: "idle", manuallyPositioned: true },
      ]
      console.log(
        "   配列順序:",
        day1Instances.map((inst) => inst.task.title),
      )

      // 翌日：ファイル読み込み順序が変わる（全てidleになる）
      console.log("\n2. 日付移動後（ファイル読み込み順序が変化）:")
      const day2Instances = [
        {
          task: { title: "タスクC", scheduledTime: null },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "タスクA", scheduledTime: "06:00" },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB", scheduledTime: "06:30" },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
      ]
      console.log(
        "   配列順序:",
        day2Instances.map((inst) => inst.task.title),
      )

      // この順序でソートすると、自動配置タスクが時刻順、手動配置タスクが最後
      const sorted = sortTaskInstances(day2Instances, timeSlotKeys)
      const sortedTitles = sorted.map((inst) => inst.task.title)

      console.log("   ソート後:", sortedTitles)
      expect(sortedTitles).toEqual(["タスクC", "タスクA", "タスクB"]) // 手動配置タスクCは元の位置を保持
    })

    test("【複雑なケース】複数の手動配置タスクと自動配置タスクの混在", () => {
      const instances = [
        {
          task: { title: "手動タスク1", scheduledTime: null },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "完了タスク", scheduledTime: "06:00" },
          state: "done",
          startTime: new Date("2024-01-15T06:00:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "自動タスク1", scheduledTime: "07:00" },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "実行中タスク", scheduledTime: "06:30" },
          state: "running",
          startTime: new Date("2024-01-15T06:30:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "手動タスク2", scheduledTime: null },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "自動タスク2", scheduledTime: "07:30" },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
      ]

      const sorted = sortTaskInstances(instances, timeSlotKeys)
      const sortedTitles = sorted.map((inst) => inst.task.title)

      console.log("複雑なケースのソート結果:", sortedTitles)

      // 期待される順序：
      // 1. 完了済み（時系列順）
      // 2. 実行中（時系列順）
      // 3. アイドル（手動配置は元の位置を保持、自動配置は時刻順）
      expect(sortedTitles).toEqual([
        "完了タスク", // done
        "実行中タスク", // running
        "手動タスク1", // idle, manual（元の位置を保持）
        "自動タスク1", // idle, auto, 07:00
        "手動タスク2", // idle, manual（元の位置を保持）
        "自動タスク2", // idle, auto, 07:30
      ])
    })
  })

  describe("修正案の検証", () => {
    test("【修正確認】実装されたソート関数が期待通りに動作する", () => {
      // テストケース
      const instances = [
        {
          task: { title: "タスクC", scheduledTime: null },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: true,
        },
        {
          task: { title: "タスクA", scheduledTime: "06:00" },
          state: "done",
          startTime: new Date("2024-01-15T06:00:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクB", scheduledTime: "06:30" },
          state: "running",
          startTime: new Date("2024-01-15T06:30:00"),
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
        {
          task: { title: "タスクD", scheduledTime: "07:00" },
          state: "idle",
          slotKey: "0:00-8:00",
          manuallyPositioned: false,
        },
      ]

      const sorted = sortTaskInstances(instances, timeSlotKeys)
      const sortedTitles = sorted.map((inst) => inst.task.title)

      console.log("実装されたソート結果:", sortedTitles)

      // 期待される順序：
      // 1. 完了済み（タスクA）
      // 2. 実行中（タスクB）
      // 3. アイドル（手動配置タスクCは元の位置を保持、タスクDは時刻順）
      expect(sortedTitles).toEqual(["タスクA", "タスクB", "タスクC", "タスクD"])
    })
  })
})
