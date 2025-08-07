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

// 実際のログ出力用のヘルパー関数
const log = (message) => {
  process.stdout.write(message + "\n")
}

describe("タスクソートバグ再現テスト", () => {
  const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]

  describe("新規ルーチンタスクのソート順序バグ", () => {
    test("【バグ再現】新規ルーチンタスクが時刻順ではなく作成順で表示される", () => {
      // シナリオ：
      // 7/10 木曜日に既存のタスクA〜Eが存在
      // タスクFを新規作成し、8:13に設定、週1回ルーチン化
      // 7/17を見ると、タスクFが最後に表示される（本来は8:13の位置に表示されるべき）

      // 既存のタスクA〜E（7/10以前に作成済み）
      const existingTasks = [
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "08:01",
            isRoutine: true,
            routineType: "weekly",
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
            scheduledTime: "08:05",
            isRoutine: true,
            routineType: "weekly",
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
            scheduledTime: "08:10",
            isRoutine: true,
            routineType: "weekly",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクD",
            path: "/task-d.md",
            scheduledTime: "08:15",
            isRoutine: true,
            routineType: "weekly",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクE",
            path: "/task-e.md",
            scheduledTime: "08:20",
            isRoutine: true,
            routineType: "weekly",
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // 新規作成されたタスクF（7/10に作成、8:13に設定）
      const newTask = {
        task: {
          title: "タスクF",
          path: "/task-f.md",
          scheduledTime: "08:13",
          isRoutine: true,
          routineType: "weekly",
        },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00",
        manuallyPositioned: false,
      }

      // タスクFが最後に追加される（ファイル作成順）
      const taskInstances = [...existingTasks, newTask]

      log("\n=== ソート前の順序 ===")
      taskInstances.forEach((inst, index) => {
        log(
          `${index + 1}. ${inst.task.title} (${
            inst.task.scheduledTime
          }) - manuallyPositioned: ${inst.manuallyPositioned}`,
        )
      })

      // ソートを実行
      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      log("\n=== ソート後の順序 ===")
      sortedInstances.forEach((inst, index) => {
        log(
          `${index + 1}. ${inst.task.title} (${
            inst.task.scheduledTime
          }) - manuallyPositioned: ${inst.manuallyPositioned}`,
        )
      })

      // 期待される順序：時刻順
      const expectedOrder = [
        "タスクA", // 08:01
        "タスクB", // 08:05
        "タスクC", // 08:10
        "タスクF", // 08:13 ← 正しい位置
        "タスクD", // 08:15
        "タスクE", // 08:20
      ]

      // 実際のバグ：タスクFが最後に表示される
      const actualBuggyOrder = [
        "タスクA", // 08:01
        "タスクB", // 08:05
        "タスクC", // 08:10
        "タスクD", // 08:15
        "タスクE", // 08:20
        "タスクF", // 08:13 ← 間違った位置
      ]

      log("\n=== 結果比較 ===")
      log("期待される順序: " + JSON.stringify(expectedOrder))
      log("実際の順序: " + JSON.stringify(sortedTitles))
      log("バグのある順序: " + JSON.stringify(actualBuggyOrder))

      // 実際の結果が期待される順序と一致するかを確認
      if (JSON.stringify(sortedTitles) === JSON.stringify(expectedOrder)) {
        log("✅ ソート処理は正しく動作しています")
      } else if (
        JSON.stringify(sortedTitles) === JSON.stringify(actualBuggyOrder)
      ) {
        log("❌ バグが再現されました！")
      } else {
        log("❓ 予期しない結果です")
      }

      // バグが発生していることを確認（現在のテストは失敗するはず）
      expect(sortedTitles).toEqual(expectedOrder)
    })

    test("【実際の問題調査】手動配置フラグの影響を確認", () => {
      log("\n=== 手動配置フラグの影響を確認 ===")

      // 手動配置フラグがtrueの場合の動作を確認
      const taskInstances = [
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "08:01",
            isRoutine: true,
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
            scheduledTime: "08:05",
            isRoutine: true,
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
            scheduledTime: "08:10",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクD",
            path: "/task-d.md",
            scheduledTime: "08:15",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクE",
            path: "/task-e.md",
            scheduledTime: "08:20",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        // 新規タスクF - 手動配置フラグがtrueの場合
        {
          task: {
            title: "タスクF",
            path: "/task-f.md",
            scheduledTime: "08:13",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: true, // 手動配置フラグがtrue
        },
      ]

      log("\n--- 手動配置フラグがtrueの場合 ---")
      log("ソート前の順序:")
      taskInstances.forEach((inst, index) => {
        log(
          `${index + 1}. ${inst.task.title} (${
            inst.task.scheduledTime
          }) - manual: ${inst.manuallyPositioned}`,
        )
      })

      const sortedInstances = sortTaskInstances(
        [...taskInstances],
        timeSlotKeys,
      )
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      log("\nソート後の順序:")
      sortedInstances.forEach((inst, index) => {
        log(
          `${index + 1}. ${inst.task.title} (${
            inst.task.scheduledTime
          }) - manual: ${inst.manuallyPositioned}`,
        )
      })

      // 手動配置フラグがtrueの場合、タスクFは最後に表示される
      const expectedOrderWithManualFlag = [
        "タスクA", // 08:01 (自動配置)
        "タスクB", // 08:05 (自動配置)
        "タスクC", // 08:10 (自動配置)
        "タスクD", // 08:15 (自動配置)
        "タスクE", // 08:20 (自動配置)
        "タスクF", // 08:13 (手動配置 - 最後に表示)
      ]

      log(
        "\n期待される順序（手動配置あり）: " +
          JSON.stringify(expectedOrderWithManualFlag),
      )
      log("実際の順序: " + JSON.stringify(sortedTitles))

      expect(sortedTitles).toEqual(expectedOrderWithManualFlag)
    })

    test("【実際の問題調査】localStorageからの復元を模倣", () => {
      log("\n=== localStorageからの復元を模倣 ===")

      // 実際のloadTasks処理では、localStorageから手動配置フラグを復元する
      // localStorage.getItem(`taskchute-manual-position-${file.path}`) === "true"

      // モックのlocalStorageを設定
      const mockLocalStorage = {
        "taskchute-manual-position-/task-f.md": "true", // タスクFが手動配置された
      }

      // localStorageから復元されたフラグを模倣
      const taskInstances = [
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "08:01",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned:
            mockLocalStorage["taskchute-manual-position-/task-a.md"] === "true",
        },
        {
          task: {
            title: "タスクB",
            path: "/task-b.md",
            scheduledTime: "08:05",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned:
            mockLocalStorage["taskchute-manual-position-/task-b.md"] === "true",
        },
        {
          task: {
            title: "タスクC",
            path: "/task-c.md",
            scheduledTime: "08:10",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned:
            mockLocalStorage["taskchute-manual-position-/task-c.md"] === "true",
        },
        {
          task: {
            title: "タスクD",
            path: "/task-d.md",
            scheduledTime: "08:15",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned:
            mockLocalStorage["taskchute-manual-position-/task-d.md"] === "true",
        },
        {
          task: {
            title: "タスクE",
            path: "/task-e.md",
            scheduledTime: "08:20",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned:
            mockLocalStorage["taskchute-manual-position-/task-e.md"] === "true",
        },
        // 新規タスクF - localStorageに手動配置フラグが保存されている
        {
          task: {
            title: "タスクF",
            path: "/task-f.md",
            scheduledTime: "08:13",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned:
            mockLocalStorage["taskchute-manual-position-/task-f.md"] === "true",
        },
      ]

      log("\n--- localStorageから復元された状態 ---")
      log("ソート前の順序:")
      taskInstances.forEach((inst, index) => {
        log(
          `${index + 1}. ${inst.task.title} (${
            inst.task.scheduledTime
          }) - manual: ${inst.manuallyPositioned}`,
        )
      })

      const sortedInstances = sortTaskInstances(
        [...taskInstances],
        timeSlotKeys,
      )
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      log("\nソート後の順序:")
      sortedInstances.forEach((inst, index) => {
        log(
          `${index + 1}. ${inst.task.title} (${
            inst.task.scheduledTime
          }) - manual: ${inst.manuallyPositioned}`,
        )
      })

      // この場合、タスクFは手動配置されているので最後に表示される
      const expectedOrder = [
        "タスクA", // 08:01 (自動配置)
        "タスクB", // 08:05 (自動配置)
        "タスクC", // 08:10 (自動配置)
        "タスクD", // 08:15 (自動配置)
        "タスクE", // 08:20 (自動配置)
        "タスクF", // 08:13 (手動配置 - 最後に表示)
      ]

      log("\n期待される順序: " + JSON.stringify(expectedOrder))
      log("実際の順序: " + JSON.stringify(sortedTitles))

      if (JSON.stringify(sortedTitles) === JSON.stringify(expectedOrder)) {
        log("✅ これがバグの原因です！手動配置フラグが誤って設定されています")
      } else {
        log("❓ 別の原因があります")
      }

      expect(sortedTitles).toEqual(expectedOrder)
    })

    test("【実際のバグ再現】JavaScriptのsort()の不安定性を再現", () => {
      // JavaScriptのsort()は不安定ソートなので、同じ比較結果(0)を返す場合に
      // 元の順序が保持されない可能性がある

      log("\n=== JavaScriptソートの不安定性テスト ===")

      // 意図的にバグを再現するためのテストケース
      const taskInstances = [
        {
          task: {
            title: "タスクA",
            path: "/task-a.md",
            scheduledTime: "08:01",
            isRoutine: true,
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
            scheduledTime: "08:05",
            isRoutine: true,
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
            scheduledTime: "08:10",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクD",
            path: "/task-d.md",
            scheduledTime: "08:15",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスクE",
            path: "/task-e.md",
            scheduledTime: "08:20",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        // 新規タスクFを最後に追加
        {
          task: {
            title: "タスクF",
            path: "/task-f.md",
            scheduledTime: "08:13",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // 複数回ソートを実行して、結果が一貫しているかを確認
      const results = []
      for (let i = 0; i < 5; i++) {
        const sortedInstances = sortTaskInstances(
          [...taskInstances],
          timeSlotKeys,
        )
        const sortedTitles = sortedInstances.map((inst) => inst.task.title)
        results.push(sortedTitles)
        log(`実行${i + 1}: ${JSON.stringify(sortedTitles)}`)
      }

      // すべての結果が一致しているかを確認
      const firstResult = results[0]
      const allSame = results.every(
        (result) => JSON.stringify(result) === JSON.stringify(firstResult),
      )

      log("全実行結果が一致: " + allSame)

      // 期待される順序
      const expectedOrder = [
        "タスクA", // 08:01
        "タスクB", // 08:05
        "タスクC", // 08:10
        "タスクF", // 08:13
        "タスクD", // 08:15
        "タスクE", // 08:20
      ]

      expect(firstResult).toEqual(expectedOrder)
    })

    test("【バグ再現】複数の新規タスクが追加された場合の順序", () => {
      // より複雑なシナリオ：複数の新規タスクが様々な時刻に追加される
      const existingTasks = [
        {
          task: {
            title: "朝の準備",
            path: "/morning.md",
            scheduledTime: "08:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "メール確認",
            path: "/email.md",
            scheduledTime: "08:30",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "会議",
            path: "/meeting.md",
            scheduledTime: "09:00",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // 新規追加されたタスク（作成順）
      const newTasks = [
        {
          task: {
            title: "コーヒータイム",
            path: "/coffee.md",
            scheduledTime: "08:15", // 朝の準備とメール確認の間
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "資料作成",
            path: "/document.md",
            scheduledTime: "08:45", // メール確認と会議の間
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "振り返り",
            path: "/review.md",
            scheduledTime: "08:10", // 朝の準備の直後
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      // 新規タスクが後から追加される（ファイル作成順）
      const taskInstances = [...existingTasks, ...newTasks]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 期待される順序：時刻順
      const expectedOrder = [
        "朝の準備", // 08:00
        "振り返り", // 08:10
        "コーヒータイム", // 08:15
        "メール確認", // 08:30
        "資料作成", // 08:45
        "会議", // 09:00
      ]

      expect(sortedTitles).toEqual(expectedOrder)
    })

    test("【バグ再現】手動配置されたタスクと自動配置されたタスクの混在", () => {
      // 手動配置されたタスクと新規追加されたタスクが混在する場合
      const taskInstances = [
        {
          task: {
            title: "手動配置タスク1",
            path: "/manual1.md",
            scheduledTime: "08:20",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: true, // 手動配置
        },
        {
          task: {
            title: "自動配置タスク1",
            path: "/auto1.md",
            scheduledTime: "08:10",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false, // 自動配置
        },
        {
          task: {
            title: "新規タスク",
            path: "/new.md",
            scheduledTime: "08:15",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false, // 自動配置（新規）
        },
        {
          task: {
            title: "手動配置タスク2",
            path: "/manual2.md",
            scheduledTime: "08:05",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: true, // 手動配置
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 期待される順序（修正後）：
      // 手動配置タスクは元の位置を保持、自動配置タスクは時刻順
      const expectedOrder = [
        "手動配置タスク1", // 手動配置（元の位置を保持）
        "自動配置タスク1", // 08:10 (自動配置、時刻順)
        "新規タスク", // 08:15 (自動配置、時刻順)
        "手動配置タスク2", // 手動配置（元の位置を保持）
      ]

      expect(sortedTitles).toEqual(expectedOrder)
    })

    test("【バグ確認】同じ時刻に複数のタスクがある場合の安定ソート", () => {
      // 同じ時刻に複数のタスクがある場合、元の順序が保持されるか
      const taskInstances = [
        {
          task: {
            title: "タスク1",
            path: "/task1.md",
            scheduledTime: "08:15",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスク2",
            path: "/task2.md",
            scheduledTime: "08:15", // 同じ時刻
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
        {
          task: {
            title: "タスク3",
            path: "/task3.md",
            scheduledTime: "08:15", // 同じ時刻
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      // 同じ時刻の場合、元の順序が保持されることを期待
      const expectedOrder = ["タスク1", "タスク2", "タスク3"]

      expect(sortedTitles).toEqual(expectedOrder)
    })
  })

  describe("ソート処理の詳細分析", () => {
    test("ソート処理の内部動作を詳しく確認", () => {
      // ソート処理の各段階を詳しく確認するテスト
      const taskInstances = [
        {
          task: {
            title: "タスクD",
            path: "/task-d.md",
            scheduledTime: "08:15",
            isRoutine: true,
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
            scheduledTime: "08:01",
            isRoutine: true,
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
            scheduledTime: "08:10",
            isRoutine: true,
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
            scheduledTime: "08:05",
            isRoutine: true,
          },
          state: "idle",
          startTime: null,
          stopTime: null,
          slotKey: "8:00-12:00",
          manuallyPositioned: false,
        },
      ]

      log("ソート前の順序:")
      taskInstances.forEach((inst, index) => {
        log(`${index + 1}. ${inst.task.title} (${inst.task.scheduledTime})`)
      })

      const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
      const sortedTitles = sortedInstances.map((inst) => inst.task.title)

      log("ソート後の順序:")
      sortedInstances.forEach((inst, index) => {
        log(`${index + 1}. ${inst.task.title} (${inst.task.scheduledTime})`)
      })

      // 時刻順に並んでいることを確認
      const expectedOrder = ["タスクA", "タスクB", "タスクC", "タスクD"]
      expect(sortedTitles).toEqual(expectedOrder)
    })
  })
})
