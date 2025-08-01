// Mock Obsidian dependencies
jest.mock("obsidian", () => ({
  Plugin: class Plugin {},
  ItemView: class ItemView {
    constructor(leaf) {
      this.leaf = leaf
    }
  },
  WorkspaceLeaf: class WorkspaceLeaf {},
  TFile: class TFile {},
  Notice: class Notice {
    constructor(message) {
      this.message = message
    }
  },
}))

const { TaskChuteView } = require("../main.js")

describe("スクロール位置保持機能", () => {
  let taskChuteView
  let mockApp
  let mockWorkspace
  let mockLeaf

  beforeEach(() => {
    // モックのセットアップ
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        on: jest.fn(), // Add the missing 'on' method
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue(null),
      },
      workspace: {
        onLayoutReady: jest.fn(),
        getLeavesOfType: jest.fn().mockReturnValue([]),
        getRightLeaf: jest.fn(),
      },
    }

    mockWorkspace = {
      containerEl: {
        children: [
          null,
          {
            empty: jest.fn(),
            createEl: jest.fn().mockImplementation(function (tag, options) {
              const element = {
                createEl: jest.fn().mockImplementation(function (tag, options) {
                  const childElement = {
                    createEl: jest.fn().mockReturnThis(),
                    addEventListener: jest.fn(),
                    empty: jest.fn(),
                    scrollTop: 0,
                    scrollLeft: 0,
                    querySelector: jest.fn(),
                    querySelectorAll: jest.fn().mockReturnValue([]),
                    classList: {
                      add: jest.fn(),
                      remove: jest.fn(),
                    },
                    setAttribute: jest.fn(),
                    textContent: "",
                    style: {},
                  }
                  if (options?.text) childElement.textContent = options.text
                  return childElement
                }),
                addEventListener: jest.fn(),
                empty: jest.fn(),
                scrollTop: 0,
                scrollLeft: 0,
                querySelector: jest.fn(),
                querySelectorAll: jest.fn().mockReturnValue([]),
                classList: {
                  add: jest.fn(),
                  remove: jest.fn(),
                },
                setAttribute: jest.fn(),
                textContent: "",
                style: {},
              }
              if (options?.text) element.textContent = options.text
              return element
            }),
          },
        ],
      },
    }

    mockLeaf = {}

    // TaskChuteViewのインスタンスを作成
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
    taskChuteView.containerEl = mockWorkspace.containerEl
    
    // 必要なプロパティとメソッドを初期化
    taskChuteView.currentDate = new Date()
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    
    // 必要なメソッドをモック
    taskChuteView.loadTasks = jest.fn().mockResolvedValue()
    taskChuteView.applyStyles = jest.fn()
    taskChuteView.updateDateLabel = jest.fn()
    taskChuteView.showAddTaskModal = jest.fn()
    taskChuteView.registerEvent = jest.fn()
    taskChuteView.saveRunningTasksState = jest.fn().mockResolvedValue()
    taskChuteView.manageTimers = jest.fn()
    taskChuteView.getCurrentTimeSlot = jest.fn().mockReturnValue("8:00-12:00")
    taskChuteView.sortTaskInstancesByTimeOrder = jest.fn()
    taskChuteView.getTimeSlotKeys = jest.fn().mockReturnValue(["8:00-12:00", "12:00-18:00"])
    taskChuteView.createTaskItem = jest.fn().mockReturnValue({
      createEl: jest.fn().mockReturnThis(),
      addEventListener: jest.fn(),
      classList: { add: jest.fn(), remove: jest.fn() },
      setAttribute: jest.fn(),
      textContent: "",
    })
  })

  describe("renderTaskList", () => {
    it("スクロール位置が保存・復元される", () => {
      // taskListを直接初期化
      taskChuteView.taskList = {
        scrollTop: 0,
        scrollLeft: 0,
        empty: jest.fn(),
        createEl: jest.fn().mockReturnValue({
          createEl: jest.fn().mockReturnThis(),
          addEventListener: jest.fn(),
          classList: { add: jest.fn(), remove: jest.fn() },
          setAttribute: jest.fn(),
          textContent: "",
        }),
      }
      
      // taskListが作成されていることを確認
      expect(taskChuteView.taskList).toBeDefined()

      // スクロール位置を設定
      taskChuteView.taskList.scrollTop = 100
      taskChuteView.taskList.scrollLeft = 50

      // setTimeoutをモック
      const originalSetTimeout = global.setTimeout
      global.setTimeout = jest.fn((callback) => callback())

      // applyResponsiveClassesをモック
      taskChuteView.applyResponsiveClasses = jest.fn()
      
      // renderTaskListを実行
      taskChuteView.renderTaskList()
      
      // スクロール位置が復元されていることを確認
      expect(taskChuteView.taskList.scrollTop).toBe(100)
      expect(taskChuteView.taskList.scrollLeft).toBe(50)

      // setTimeoutを元に戻す
      global.setTimeout = originalSetTimeout
    })
  })

  describe("updateTaskItemDisplay", () => {
    let mockTaskItem
    let mockPlayButton
    let inst

    beforeEach(() => {
      // モックDOM要素の作成
      mockPlayButton = {
        classList: {
          add: jest.fn(),
          remove: jest.fn(),
        },
        textContent: "",
        setAttribute: jest.fn(),
      }

      mockTaskItem = {
        querySelector: jest.fn().mockImplementation((selector) => {
          if (selector === ".play-stop-button") return mockPlayButton
          if (selector === ".task-time-range") return { textContent: "" }
          if (selector === ".task-duration") return null
          if (selector === ".task-timer-display") return null
          if (selector === ".routine-button") return null
          return null
        }),
        createEl: jest.fn().mockReturnValue({
          textContent: "",
        }),
        insertBefore: jest.fn(),
        classList: {
          add: jest.fn(),
          remove: jest.fn(),
        },
      }

      inst = {
        task: { title: "テストタスク" },
        state: "idle",
        startTime: null,
        stopTime: null,
      }
    })

    it("実行中状態への更新", () => {
      inst.state = "running"
      inst.startTime = new Date("2024-01-01T10:00:00")

      taskChuteView.updateTaskItemDisplay(mockTaskItem, inst)

      expect(mockPlayButton.classList.add).toHaveBeenCalledWith("stop")
      expect(mockPlayButton.textContent).toBe("⏹")
      expect(mockPlayButton.setAttribute).toHaveBeenCalledWith(
        "title",
        "ストップ",
      )
    })

    it("完了状態への更新", () => {
      inst.state = "done"
      inst.startTime = new Date("2024-01-01T10:00:00")
      inst.stopTime = new Date("2024-01-01T10:30:00")

      taskChuteView.updateTaskItemDisplay(mockTaskItem, inst)

      expect(mockPlayButton.classList.remove).toHaveBeenCalledWith("stop")
      expect(mockPlayButton.textContent).toBe("☑️")
      expect(mockPlayButton.setAttribute).toHaveBeenCalledWith(
        "title",
        "完了タスクを再計測",
      )
      expect(mockTaskItem.classList.add).toHaveBeenCalledWith("completed")
    })

    it("アイドル状態への更新", () => {
      inst.state = "idle"

      taskChuteView.updateTaskItemDisplay(mockTaskItem, inst)

      expect(mockPlayButton.classList.remove).toHaveBeenCalledWith("stop")
      expect(mockPlayButton.textContent).toBe("▶️")
      expect(mockPlayButton.setAttribute).toHaveBeenCalledWith(
        "title",
        "スタート",
      )
      expect(mockTaskItem.classList.remove).toHaveBeenCalledWith("completed")
    })
  })

  describe("タスク開始・停止時の動作", () => {
    it("タスク開始時は常にrenderTaskListが呼ばれる", async () => {
      const inst = {
        task: { title: "テストタスク", path: "test.md" },
        state: "idle",
        slotKey: "8:00-12:00",
        originalSlotKey: null,
      }

      // taskListを初期化（onOpenを呼ばずに直接設定）
      taskChuteView.taskList = {
        scrollTop: 0,
        scrollLeft: 0,
        empty: jest.fn(),
        createEl: jest.fn().mockReturnValue({
          createEl: jest.fn().mockReturnThis(),
          addEventListener: jest.fn(),
          classList: { add: jest.fn(), remove: jest.fn() },
          setAttribute: jest.fn(),
          textContent: "",
        }),
      }

      // renderTaskListをスパイ
      const renderSpy = jest.spyOn(taskChuteView, "renderTaskList")
      taskChuteView.saveRunningTasksState = jest.fn().mockResolvedValue()
      taskChuteView.manageTimers = jest.fn()

      await taskChuteView.startInstance(inst)

      expect(inst.state).toBe("running")
      expect(inst.originalSlotKey).toBe("8:00-12:00")
      expect(renderSpy).toHaveBeenCalled() // 修正: 常に呼ばれる
    })

    it("時間指定なしから開始した場合はrenderTaskListが呼ばれる", async () => {
      const inst = {
        task: { title: "テストタスク", path: "test.md" },
        state: "idle",
        slotKey: "none",
        originalSlotKey: null,
      }

      // taskListを初期化（onOpenを呼ばずに直接設定）
      taskChuteView.taskList = {
        scrollTop: 0,
        scrollLeft: 0,
        empty: jest.fn(),
        createEl: jest.fn().mockReturnValue({
          createEl: jest.fn().mockReturnThis(),
          addEventListener: jest.fn(),
          classList: { add: jest.fn(), remove: jest.fn() },
          setAttribute: jest.fn(),
          textContent: "",
        }),
      }

      // renderTaskListをスパイ
      const renderSpy = jest.spyOn(taskChuteView, "renderTaskList")
      taskChuteView.saveRunningTasksState = jest.fn().mockResolvedValue()
      taskChuteView.manageTimers = jest.fn()
      taskChuteView.getCurrentTimeSlot = jest.fn().mockReturnValue("8:00-12:00")

      await taskChuteView.startInstance(inst)

      expect(inst.state).toBe("running")
      expect(inst.slotKey).toBe("8:00-12:00")
      expect(inst.originalSlotKey).toBe("none")
      expect(renderSpy).toHaveBeenCalled()
    })
  })
})
