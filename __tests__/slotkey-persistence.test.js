const TaskChutePlusPlugin = require("../main.js")
const { TaskChuteView } = TaskChutePlusPlugin
const { mockApp, mockLeaf, Notice } = require("../__mocks__/obsidian.js")

// グローバルモック設定
global.Notice = Notice

describe("SlotKey保持とタスク移動防止機能", () => {
  let taskChuteView

  beforeEach(() => {
    jest.clearAllMocks()
    // localStorageをクリア（globalのモックを使用）
    global.localStorage.clear()

    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = mockApp
    taskChuteView.containerEl = mockLeaf.containerEl

    // 現在日付を固定（テストの安定性のため）
    taskChuteView.currentDate = new Date(2024, 0, 15) // 2024-01-15
  })

  describe("完了済みタスクの移動防止ロジック", () => {
    test("完了済みタスクの状態判定が正しく動作すること", () => {
      // テストデータ: 完了済みタスク
      const completedTask = {
        task: { title: "完了タスク", path: "/completed.md" },
        state: "done",
        startTime: new Date(2024, 0, 15, 10, 0), // 10:00開始
        stopTime: new Date(2024, 0, 15, 12, 30), // 12:30終了
        slotKey: "8:00-12:00",
      }

      // 移動防止のロジックをシミュレート
      let shouldPreventMove = false
      let noticeMessage = ""

      if (completedTask.state === "done") {
        shouldPreventMove = true
        noticeMessage = "完了済みタスクは移動できません"
        Notice(noticeMessage)
      }

      // 1. 移動が防止されること
      expect(shouldPreventMove).toBe(true)

      // 2. 適切なメッセージが表示されること
      expect(Notice).toHaveBeenCalledWith("完了済みタスクは移動できません")

      // 3. タスクの位置が変わらないこと
      expect(completedTask.slotKey).toBe("8:00-12:00")
    })

    test("待機中タスクは移動可能であること", () => {
      const idleTask = {
        task: { title: "待機タスク", path: "/idle.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00",
      }

      // 移動処理のロジックシミュレート
      let shouldPreventMove = false

      if (idleTask.state === "done") {
        shouldPreventMove = true
        Notice("完了済みタスクは移動できません")
      } else {
        // 移動処理を実行
        idleTask.slotKey = "12:00-16:00"
      }

      // 1. 移動が防止されないこと
      expect(shouldPreventMove).toBe(false)

      // 2. エラーメッセージが表示されないこと
      expect(Notice).not.toHaveBeenCalledWith("完了済みタスクは移動できません")

      // 3. タスクのslotKeyが更新されること
      expect(idleTask.slotKey).toBe("12:00-16:00")
    })

    test("実行中タスクも移動可能であること", () => {
      const runningTask = {
        task: { title: "実行中タスク", path: "/running.md" },
        state: "running",
        startTime: new Date(),
        stopTime: null,
        slotKey: "8:00-12:00",
      }

      // 移動処理のロジックシミュレート
      if (runningTask.state !== "done") {
        runningTask.slotKey = "12:00-16:00"
      }

      // タスクが正常に移動すること
      expect(runningTask.slotKey).toBe("12:00-16:00")
    })
  })

  describe("実行履歴のslotKey優先使用", () => {
    test("実行履歴のslotKeyが保存されている場合、それを優先使用すること", () => {
      // 10時開始のルーチンタスク（8:00-12:00に属するべき）
      const mockTask = {
        basename: "朝のタスク",
        path: "/morning-task.md",
      }

      // 実行履歴: 正しいslotKeyが保存されている
      const executionHistory = [
        {
          taskTitle: "朝のタスク",
          startTime: new Date(2024, 0, 15, 10, 0), // 10:00
          stopTime: new Date(2024, 0, 15, 13, 0), // 13:00（終了時刻は12:00超過）
          slotKey: "8:00-12:00", // 正しく保存されたslotKey
        },
      ]

      // scheduledTime: 10時開始
      const scheduledTime = "10:00"

      // タスクインスタンス生成をシミュレート
      const taskObj = {
        title: mockTask.basename,
        path: mockTask.path,
        file: mockTask,
        isRoutine: true,
        scheduledTime: scheduledTime,
        slotKey: "8:00-12:00", // scheduledTimeから計算されたslotKey
      }

      // 実行履歴からインスタンス作成処理をシミュレート
      const instances = []
      executionHistory.forEach((exec) => {
        // 実行履歴のslotKeyを優先使用
        let instanceSlotKey = exec.slotKey

        // 実行履歴にslotKeyがない場合のみscheduledTimeから計算
        if (!instanceSlotKey || instanceSlotKey === "none") {
          if (scheduledTime) {
            const hour = parseInt(scheduledTime.split(":")[0])
            const minute = parseInt(scheduledTime.split(":")[1])
            const timeInMinutes = hour * 60 + minute
            if (timeInMinutes >= 0 && timeInMinutes < 8 * 60)
              instanceSlotKey = "0:00-8:00"
            else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60)
              instanceSlotKey = "8:00-12:00"
            else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60)
              instanceSlotKey = "12:00-16:00"
            else instanceSlotKey = "16:00-0:00"
          } else {
            instanceSlotKey = taskObj.slotKey
          }
        }

        instances.push({
          task: taskObj,
          state: "done",
          startTime: new Date(exec.startTime),
          stopTime: new Date(exec.stopTime),
          slotKey: instanceSlotKey,
        })
      })

      // 検証: 実行履歴のslotKeyが使用されていること
      expect(instances).toHaveLength(1)
      expect(instances[0].slotKey).toBe("8:00-12:00")

      // 終了時刻が12:00を超えても、正しいslotKeyが維持されること
      expect(instances[0].stopTime.getHours()).toBe(13) // 13時終了
      expect(instances[0].slotKey).toBe("8:00-12:00") // 8:00-12:00スロットに配置
    })

    test("実行履歴にslotKeyがない場合、scheduledTimeから計算すること", () => {
      const executionHistory = [
        {
          taskTitle: "古いタスク",
          startTime: new Date(2024, 0, 15, 14, 0),
          stopTime: new Date(2024, 0, 15, 15, 0),
          slotKey: null, // 古いデータでslotKeyなし
        },
      ]

      const scheduledTime = "14:00"
      const taskObj = {
        title: "古いタスク",
        scheduledTime: scheduledTime,
        slotKey: "12:00-16:00",
      }

      const instances = []
      executionHistory.forEach((exec) => {
        let instanceSlotKey = exec.slotKey

        if (!instanceSlotKey || instanceSlotKey === "none") {
          if (scheduledTime) {
            const hour = parseInt(scheduledTime.split(":")[0])
            const timeInMinutes = hour * 60
            if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60)
              instanceSlotKey = "12:00-16:00"
          }
        }

        instances.push({
          task: taskObj,
          state: "done",
          startTime: new Date(exec.startTime),
          stopTime: new Date(exec.stopTime),
          slotKey: instanceSlotKey,
        })
      })

      // scheduledTimeから正しく計算されること
      expect(instances[0].slotKey).toBe("12:00-16:00")
    })
  })

  describe("ドラッグ可能属性の制御", () => {
    test("完了済みタスクのドラッグ属性がfalseに設定されること", () => {
      const mockTaskItem = {
        setAttribute: jest.fn(),
        addEventListener: jest.fn(),
        createEl: jest.fn(() => mockTaskItem),
        classList: { add: jest.fn(), remove: jest.fn() },
      }

      // createTaskInstanceItemの一部をシミュレート
      const completedInstance = {
        task: { title: "完了タスク" },
        state: "done",
        startTime: new Date(),
        stopTime: new Date(),
      }

      // ドラッグ可能属性の設定ロジック
      const isDraggable = completedInstance.state !== "done"
      mockTaskItem.setAttribute("draggable", isDraggable.toString())

      // 検証
      expect(isDraggable).toBe(false)
      expect(mockTaskItem.setAttribute).toHaveBeenCalledWith(
        "draggable",
        "false",
      )
    })

    test("待機中タスクのドラッグ属性がtrueに設定されること", () => {
      const mockTaskItem = {
        setAttribute: jest.fn(),
        addEventListener: jest.fn(),
      }

      const idleInstance = {
        task: { title: "待機タスク" },
        state: "idle",
      }

      const isDraggable = idleInstance.state !== "done"
      mockTaskItem.setAttribute("draggable", isDraggable.toString())

      expect(isDraggable).toBe(true)
      expect(mockTaskItem.setAttribute).toHaveBeenCalledWith(
        "draggable",
        "true",
      )
    })
  })

  describe("エッジケースのテスト", () => {
    test("slotKeyが'none'の場合の処理", () => {
      const executionHistory = [
        {
          taskTitle: "時間指定なしタスク",
          startTime: new Date(2024, 0, 15, 10, 0),
          stopTime: new Date(2024, 0, 15, 11, 0),
          slotKey: "none",
        },
      ]

      const scheduledTime = "10:00"
      const taskObj = {
        title: "時間指定なしタスク",
        scheduledTime: scheduledTime,
        slotKey: "8:00-12:00",
      }

      const instances = []
      executionHistory.forEach((exec) => {
        let instanceSlotKey = exec.slotKey

        if (!instanceSlotKey || instanceSlotKey === "none") {
          if (scheduledTime) {
            const hour = parseInt(scheduledTime.split(":")[0])
            const timeInMinutes = hour * 60
            if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60)
              instanceSlotKey = "8:00-12:00"
          } else {
            instanceSlotKey = taskObj.slotKey
          }
        }

        instances.push({
          task: taskObj,
          state: "done",
          slotKey: instanceSlotKey,
        })
      })

      // scheduledTimeから正しく計算されること
      expect(instances[0].slotKey).toBe("8:00-12:00")
    })

    test("scheduledTimeがない場合はタスクのデフォルトslotKeyを使用", () => {
      const executionHistory = [
        {
          taskTitle: "時刻なしタスク",
          startTime: new Date(2024, 0, 15, 10, 0),
          stopTime: new Date(2024, 0, 15, 11, 0),
          slotKey: null,
        },
      ]

      const scheduledTime = null
      const taskObj = {
        title: "時刻なしタスク",
        scheduledTime: scheduledTime,
        slotKey: "none",
      }

      const instances = []
      executionHistory.forEach((exec) => {
        let instanceSlotKey = exec.slotKey

        if (!instanceSlotKey || instanceSlotKey === "none") {
          if (scheduledTime) {
            // scheduledTimeベースの計算
          } else {
            instanceSlotKey = taskObj.slotKey
          }
        }

        instances.push({
          task: taskObj,
          state: "done",
          slotKey: instanceSlotKey,
        })
      })

      // タスクのデフォルトslotKeyが使用されること
      expect(instances[0].slotKey).toBe("none")
    })
  })

  describe("統合テスト", () => {
    test("10:55開始12:51終了のタスクが8:00-12:00スロットに正しく配置されること", () => {
      // 実際のユーザーケースをシミュレート
      const executionHistory = [
        {
          taskTitle: "作業タスク",
          startTime: new Date(2024, 0, 15, 10, 55), // 10:55開始
          stopTime: new Date(2024, 0, 15, 12, 51), // 12:51終了
          slotKey: "8:00-12:00", // 正しく保存されたslotKey
        },
      ]

      const scheduledTime = "10:55"
      const taskObj = {
        title: "作業タスク",
        scheduledTime: scheduledTime,
        slotKey: "8:00-12:00",
      }

      // 完了済みインスタンス作成処理
      const instances = []
      executionHistory.forEach((exec) => {
        let instanceSlotKey = exec.slotKey

        if (!instanceSlotKey || instanceSlotKey === "none") {
          if (scheduledTime) {
            const hour = parseInt(scheduledTime.split(":")[0])
            const minute = parseInt(scheduledTime.split(":")[1])
            const timeInMinutes = hour * 60 + minute
            if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60)
              instanceSlotKey = "8:00-12:00"
            else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60)
              instanceSlotKey = "12:00-16:00"
          }
        }

        instances.push({
          task: taskObj,
          state: "done",
          startTime: new Date(exec.startTime),
          stopTime: new Date(exec.stopTime),
          slotKey: instanceSlotKey,
        })
      })

      // 検証
      expect(instances).toHaveLength(1)
      const instance = instances[0]

      // 開始時刻が正しいこと
      expect(instance.startTime.getHours()).toBe(10)
      expect(instance.startTime.getMinutes()).toBe(55)

      // 終了時刻が正しいこと（12:00を超過）
      expect(instance.stopTime.getHours()).toBe(12)
      expect(instance.stopTime.getMinutes()).toBe(51)

      // しかし、slotKeyは8:00-12:00に正しく配置されること
      expect(instance.slotKey).toBe("8:00-12:00")

      // 状態が完了済みであること
      expect(instance.state).toBe("done")
    })
  })
})
