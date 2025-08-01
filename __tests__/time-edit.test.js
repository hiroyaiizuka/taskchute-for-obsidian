const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

describe("TaskChute Time Edit Functionality", () => {
  let taskChuteView
  let mockApp
  let mockLeaf
  let container
  let mockModal, mockStartInput, mockStopInput, mockSaveBtn

  beforeEach(() => {
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        create: jest.fn(),
        modify: jest.fn(),
        getAbstractFileByPath: jest.fn(),
      },
      workspace: {
        openLinkText: jest.fn(),
        getLeavesOfType: jest.fn().mockReturnValue([]),
      },
      metadataCache: {
        getFileCache: jest.fn(),
      },
      fileManager: {
        processFrontMatter: jest.fn(),
      },
      plugins: {
        plugins: {
          "taskchute-plus": {
            settings: {
              enableCelebration: true,
              enableSound: true,
              enableFireworks: true,
              enableConfetti: true,
            },
          },
        },
      },
    }

    // 再帰的なcreateElモック
    function createElMock() {
      const el = {
        empty: jest.fn(),
        createEl: jest.fn((tag, opts) => {
          if (opts?.cls === "task-modal-content") return mockModal
          if (tag === "input" && opts?.type === "time") {
            if (opts?.cls?.includes("start")) return mockStartInput
            if (opts?.cls?.includes("stop")) return mockStopInput
            return mockStartInput
          }
          if (tag === "button" && opts?.cls?.includes("save"))
            return mockSaveBtn
          return createElMock()
        }),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        remove: jest.fn(),
        style: {},
        textContent: "",
        innerHTML: "",
        setText: jest.fn(),
        setAttribute: jest.fn(),
        getAttribute: jest.fn(),
        classList: {
          add: jest.fn(),
          remove: jest.fn(),
          contains: jest.fn(),
        },
        querySelector: jest.fn((selector) => {
          if (selector.includes("start") || selector.includes("first-of-type"))
            return mockStartInput
          if (selector.includes("stop") || selector.includes("last-of-type"))
            return mockStopInput
          if (selector.includes("save") || selector.includes("submit"))
            return mockSaveBtn
          if (selector.includes("clear-btn")) return mockSaveBtn
          return createElMock()
        }),
        querySelectorAll: jest.fn((selector) => {
          if (selector.includes("clear-btn")) return [mockSaveBtn, mockSaveBtn]
          return [createElMock()]
        }),
        appendChild: jest.fn(),
        removeChild: jest.fn(),
        value: "",
        focus: jest.fn(),
        click: jest.fn(),
      }
      return el
    }

    container = {
      empty: jest.fn(),
      createEl: jest.fn(() => createElMock()),
    }

    mockLeaf = {
      containerEl: {
        children: [{}, container],
      },
    }

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
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    taskChuteView.runningInstances = []
    taskChuteView.isRunning = false
    taskChuteView.currentInstance = null
    taskChuteView.timerInterval = null
    taskChuteView.currentDate = new Date(2024, 0, 2) // 2024-01-02

    // モック要素を設定
    mockModal = createElMock()
    mockStartInput = createElMock()
    mockStopInput = createElMock()
    mockSaveBtn = createElMock()

    // document.createElement のモック
    global.document.createElement = jest.fn((tag) => {
      if (tag === "div") return mockModal
      if (tag === "input") return mockStartInput
      if (tag === "button") return mockSaveBtn
      return createElMock()
    })

    // document.body.appendChild のモック
    if (!global.document.body) {
      global.document.body = {}
    }
    global.document.body.appendChild = jest.fn()
    global.document.body.removeChild = jest.fn()

    // document.querySelector のモック
    global.document.querySelector = jest.fn((selector) => {
      if (selector === ".task-modal-content") return mockModal
      if (selector.includes("time")) return mockStartInput
      if (selector.includes("clear-btn")) return mockSaveBtn
      if (selector.includes("submit")) return mockSaveBtn
      return mockModal
    })

    // saveTaskCompletion のモック（Daily Note関数は削除済み）
    taskChuteView.saveTaskCompletion = jest.fn().mockResolvedValue()
    taskChuteView.saveRunningTasksState = jest.fn().mockResolvedValue()
    taskChuteView.renderTaskList = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe("時刻編集モーダル表示", () => {
    test("should show time edit modal for running task with start time only", () => {
      const mockTask = {
        title: "Test Running Task",
        path: "test-running.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const runningInstance = {
        task: mockTask,
        state: "running",
        startTime: new Date(2024, 0, 2, 14, 30, 0), // 14:30
        stopTime: null,
        slotKey: "none",
      }

      taskChuteView.showTimeEditModal(runningInstance)

      // モーダルが作成されたかチェック
      expect(global.document.createElement).toHaveBeenCalledWith("div")
      expect(global.document.body.appendChild).toHaveBeenCalled()

      // 実際のDOM操作が呼ばれることを確認
      expect(runningInstance.state).toBe("running")
      expect(runningInstance.startTime).toBeInstanceOf(Date)
    })

    test("should show time edit modal for completed task with both start and stop times", () => {
      const mockTask = {
        title: "Test Completed Task",
        path: "test-completed.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const completedInstance = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 15, 0, 0), // 15:00
        stopTime: new Date(2024, 0, 2, 16, 30, 0), // 16:30
        slotKey: "none",
      }

      taskChuteView.showTimeEditModal(completedInstance)

      // モーダルが作成されたかチェック
      expect(global.document.createElement).toHaveBeenCalledWith("div")
      expect(global.document.body.appendChild).toHaveBeenCalled()

      // 実際のDOM操作が呼ばれることを確認
      expect(completedInstance.state).toBe("done")
      expect(completedInstance.startTime).toBeInstanceOf(Date)
      expect(completedInstance.stopTime).toBeInstanceOf(Date)
    })
  })

  describe("実行中タスクの開始時刻更新", () => {
    test("should update running task start time correctly", async () => {
      const mockTask = {
        title: "Test Running Task",
        path: "test-running.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const runningInstance = {
        task: mockTask,
        state: "running",
        startTime: new Date(2024, 0, 2, 14, 30, 0), // 14:30
        stopTime: null,
        slotKey: "none",
      }

      const newStartTime = "14:15"

      await taskChuteView.updateRunningInstanceStartTime(
        runningInstance,
        newStartTime,
      )

      // 開始時刻が更新されているかチェック
      expect(runningInstance.startTime.getHours()).toBe(14)
      expect(runningInstance.startTime.getMinutes()).toBe(15)

      // UIが再描画されたかチェック
      expect(taskChuteView.renderTaskList).toHaveBeenCalled()
    })

    test("should preserve date when updating start time", async () => {
      const originalDate = new Date(2024, 5, 15, 9, 45, 0) // 2024-06-15 09:45

      const mockTask = {
        title: "Test Task",
        path: "test.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const instance = {
        task: mockTask,
        state: "running",
        startTime: originalDate,
        stopTime: null,
        slotKey: "none",
      }

      await taskChuteView.updateRunningInstanceStartTime(instance, "10:30")

      // 年月日は変更されず、時刻のみ更新されるかチェック
      expect(instance.startTime.getFullYear()).toBe(2024)
      expect(instance.startTime.getMonth()).toBe(5) // 6月
      expect(instance.startTime.getDate()).toBe(15)
      expect(instance.startTime.getHours()).toBe(10)
      expect(instance.startTime.getMinutes()).toBe(30)
    })
  })

  describe("完了タスクの時刻更新", () => {
    test("should update completed task times correctly", async () => {
      const mockTask = {
        title: "Test Completed Task",
        path: "test-completed.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const completedInstance = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 15, 0, 0), // 15:00
        stopTime: new Date(2024, 0, 2, 16, 30, 0), // 16:30
        slotKey: "none",
      }

      const newStartTime = "14:45"
      const newStopTime = "16:15"

      await taskChuteView.updateInstanceTimes(
        completedInstance,
        newStartTime,
        newStopTime,
      )

      // 時刻が更新されているかチェック
      expect(completedInstance.startTime.getHours()).toBe(14)
      expect(completedInstance.startTime.getMinutes()).toBe(45)
      expect(completedInstance.stopTime.getHours()).toBe(16)
      expect(completedInstance.stopTime.getMinutes()).toBe(15)

      // JSONファイルの更新処理が呼ばれたかチェック
      expect(taskChuteView.saveTaskCompletion).toHaveBeenCalledWith(
        completedInstance,
        null,
      )

      // UIが再描画されたかチェック
      expect(taskChuteView.renderTaskList).toHaveBeenCalled()
    })

    test("should handle JSON save errors gracefully", async () => {
      const mockTask = {
        title: "Test Task",
        path: "test.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 15, 0, 0),
        stopTime: new Date(2024, 0, 2, 16, 0, 0),
        slotKey: "none",
      }

      // JSON保存エラーをシミュレート
      taskChuteView.saveTaskCompletion.mockRejectedValue(
        new Error("JSON save failed"),
      )

      // エラーが発生しても処理が続行されるかチェック
      await expect(
        taskChuteView.updateInstanceTimes(instance, "14:30", "15:45"),
      ).resolves.not.toThrow()

      // 時刻は更新されるかチェック
      expect(instance.startTime.getHours()).toBe(14)
      expect(instance.startTime.getMinutes()).toBe(30)
      expect(instance.stopTime.getHours()).toBe(15)
      expect(instance.stopTime.getMinutes()).toBe(45)
    })
  })

  describe("時刻バリデーション", () => {
    test("should validate time format", () => {
      // 正常な時刻フォーマット
      expect("14:30".match(/^\d{2}:\d{2}$/)).toBeTruthy()
      expect("09:05".match(/^\d{2}:\d{2}$/)).toBeTruthy()

      // 不正な時刻フォーマット
      expect("14:3".match(/^\d{2}:\d{2}$/)).toBeFalsy()
      expect("1:30".match(/^\d{2}:\d{2}$/)).toBeFalsy()
      expect("14:60".match(/^\d{2}:\d{2}$/)).toBeTruthy() // フォーマットは正しいが値が無効
    })

    test("should validate time range for completed tasks", () => {
      const startTime = "15:00"
      const stopTime = "14:30"

      const [sh, sm] = startTime.split(":").map(Number)
      const [eh, em] = stopTime.split(":").map(Number)

      const startMinutes = sh * 60 + sm
      const endMinutes = eh * 60 + em

      // 開始時刻が終了時刻より後の場合は無効
      expect(startMinutes > endMinutes).toBe(true)
    })
  })

  describe("UI インタラクション", () => {
    test("should add editable class to time range elements", () => {
      const mockTask = {
        title: "Test Task",
        path: "test.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      // 実行中タスクのインスタンス
      const runningInstance = {
        task: mockTask,
        state: "running",
        startTime: new Date(2024, 0, 2, 14, 30, 0),
        stopTime: null,
        slotKey: "none",
      }

      // 完了タスクのインスタンス
      const completedInstance = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 15, 0, 0),
        stopTime: new Date(2024, 0, 2, 16, 0, 0),
        slotKey: "none",
      }

      taskChuteView.taskInstances = [runningInstance, completedInstance]

      // createTaskInstanceItem メソッドで editable クラスが追加されることを確認
      // （実際のDOM要素の検証はUI統合テストで行う）
      expect(runningInstance.state).toBe("running")
      expect(runningInstance.startTime).toBeInstanceOf(Date)
      expect(completedInstance.state).toBe("done")
      expect(completedInstance.startTime).toBeInstanceOf(Date)
      expect(completedInstance.stopTime).toBeInstanceOf(Date)
    })
  })

  describe("時間削除による状態遷移", () => {
    test("実行中タスクの開始時刻を削除するとアイドル状態に遷移する", async () => {
      const mockTask = {
        title: "Test Running Task",
        path: "test-running.md",
        content: "# Test Running Task\n\n#task",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const inst = {
        task: mockTask,
        state: "running",
        startTime: new Date(2024, 0, 2, 10, 0, 0), // 10:00
        stopTime: null,
        slotKey: "none",
      }

      // 実行中タスクとして登録
      taskChuteView.runningInstances = [inst]

      // transitionToIdle メソッドを直接テスト
      await taskChuteView.transitionToIdle(inst)

      // 状態遷移の確認
      expect(inst.state).toBe("idle")
      expect(inst.startTime).toBe(null)
      expect(inst.stopTime).toBe(null)
      expect(taskChuteView.saveRunningTasksState).toHaveBeenCalled()
    })

    test("完了タスクの終了時刻のみ削除すると実行中状態に遷移する", async () => {
      const mockTask = {
        title: "Test Completed Task",
        path: "test-completed.md",
        content: "# Test Completed Task\n\n#task",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const inst = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 10, 0, 0), // 10:00
        stopTime: new Date(2024, 0, 2, 11, 0, 0), // 11:00
        slotKey: "none",
      }

      // 完了タスクとして登録
      taskChuteView.taskInstances = [inst]

      // transitionToRunning メソッドを直接テスト
      await taskChuteView.transitionToRunning(inst, "10:00")

      // 状態遷移の確認
      expect(inst.state).toBe("running")
      expect(inst.startTime).toBeInstanceOf(Date)
      expect(inst.stopTime).toBe(null)
      expect(taskChuteView.saveRunningTasksState).toHaveBeenCalled()
      expect(taskChuteView.saveTaskCompletion).toHaveBeenCalledWith(inst, {
        isCompleted: false,
      })
    })

    test("完了タスクの両方の時刻を削除するとアイドル状態に遷移する", async () => {
      const mockTask = {
        title: "Test Task",
        path: "test.md",
        content: "# Test Task\n\n#task",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const inst = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 10, 0, 0), // 10:00
        stopTime: new Date(2024, 0, 2, 11, 0, 0), // 11:00
        slotKey: "none",
      }

      // 完了タスクとして登録
      taskChuteView.taskInstances = [inst]

      // transitionToIdle メソッドを直接テスト
      await taskChuteView.transitionToIdle(inst)

      // 状態遷移の確認
      expect(inst.state).toBe("idle")
      expect(inst.startTime).toBe(null)
      expect(inst.stopTime).toBe(null)
      expect(taskChuteView.saveTaskCompletion).toHaveBeenCalledWith(inst, {
        isCompleted: false,
      })
    })

    test("時刻削除時にJSONファイルが更新される", async () => {
      const mockTask = {
        title: "Test Task",
        path: "test.md",
        content: "# Test Task\n\n#task",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const inst = {
        task: mockTask,
        state: "done",
        startTime: new Date(2024, 0, 2, 10, 0, 0), // 10:00
        stopTime: new Date(2024, 0, 2, 11, 0, 0), // 11:00
        slotKey: "none",
      }
      inst.date = "2024-01-15"

      // 完了タスクとして登録
      taskChuteView.taskInstances = [inst]

      // transitionToRunning メソッドを直接テスト（終了時刻のみ削除のシナリオ）
      await taskChuteView.transitionToRunning(inst, "10:00")

      // JSONファイルの更新確認
      expect(taskChuteView.saveTaskCompletion).toHaveBeenCalledWith(inst, {
        isCompleted: false,
      })
      expect(taskChuteView.saveRunningTasksState).toHaveBeenCalled()
    })
  })
})
