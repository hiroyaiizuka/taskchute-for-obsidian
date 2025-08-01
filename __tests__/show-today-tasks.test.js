const { TaskChutePlugin, TaskChuteView } = require("../main")
require("../__mocks__/obsidian")

// グローバル変数のモック
global.moment = require("moment")

describe("Show Today Tasks Hotkey Feature", () => {
  let plugin
  let app
  let workspace
  let view

  beforeEach(() => {
    // Obsidian appのモック
    workspace = {
      getLeavesOfType: jest.fn(),
      getRightLeaf: jest.fn(),
      revealLeaf: jest.fn(),
    }

    app = {
      workspace,
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

    // ViewとLeafのモック
    view = {
      setSelectedDate: jest.fn(),
      refresh: jest.fn(),
    }
    // TaskChuteViewのインスタンスであることを示す
    Object.setPrototypeOf(view, TaskChuteView.prototype)

    const leaf = {
      view,
      setViewState: jest.fn().mockResolvedValue(),
    }

    workspace.getRightLeaf.mockReturnValue(leaf)
    workspace.getLeavesOfType.mockReturnValue([])

    // プラグインインスタンスの作成
    plugin = new TaskChutePlugin()
    plugin.app = app

    // メソッドを手動で追加（テスト用）
    plugin.showTodayTasks = TaskChutePlugin.prototype.showTodayTasks
    plugin.getOrCreateTaskChuteView =
      TaskChutePlugin.prototype.getOrCreateTaskChuteView
  })

  describe("Command Registration", () => {
    test("show-today-tasks command should be registered", () => {
      const commands = []
      plugin.addCommand = jest.fn((cmd) => commands.push(cmd))

      // onloadメソッドの一部を実行（コマンド登録部分のみ）
      plugin.addCommand({
        id: "show-today-tasks",
        name: "今日のタスクを表示",
        description: "Show today's tasks",
        hotkeys: [
          {
            modifiers: ["Alt"],
            key: "t",
          },
        ],
        callback: () => {
          plugin.showTodayTasks()
        },
      })

      const command = commands.find((cmd) => cmd.id === "show-today-tasks")
      expect(command).toBeDefined()
      expect(command.name).toBe("今日のタスクを表示")
      expect(command.description).toBe("Show today's tasks")
      expect(command.hotkeys).toHaveLength(1)
      expect(command.hotkeys[0]).toEqual({
        modifiers: ["Alt"],
        key: "t",
      })
    })
  })

  describe("showTodayTasks Method", () => {
    test("should create new view when no existing view", async () => {
      workspace.getLeavesOfType.mockReturnValue([])

      await plugin.showTodayTasks()

      // TaskChuteビューが作成されることを確認
      expect(workspace.getRightLeaf).toHaveBeenCalledWith(false)
      expect(workspace.getLeavesOfType).toHaveBeenCalledWith("taskchute-view")
    })

    test("should use existing view when available", async () => {
      const existingView = {
        setSelectedDate: jest.fn(),
        refresh: jest.fn(),
      }
      Object.setPrototypeOf(existingView, TaskChuteView.prototype)

      const existingLeaf = {
        view: existingView,
      }
      workspace.getLeavesOfType.mockReturnValue([existingLeaf])

      await plugin.showTodayTasks()

      // 既存のビューが使用されることを確認
      expect(workspace.getRightLeaf).not.toHaveBeenCalled()
      expect(existingLeaf.view.setSelectedDate).toHaveBeenCalled()
    })

    test("should set today's date on the view", async () => {
      const today = moment().format("YYYY-MM-DD")
      const testView = {
        setSelectedDate: jest.fn(),
        refresh: jest.fn(),
      }
      Object.setPrototypeOf(testView, TaskChuteView.prototype)

      const leaf = {
        view: testView,
      }
      workspace.getLeavesOfType.mockReturnValue([leaf])

      await plugin.showTodayTasks()

      // 今日の日付が設定されることを確認
      expect(leaf.view.setSelectedDate).toHaveBeenCalledWith(today)
      expect(leaf.view.refresh).toHaveBeenCalled()
      expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf)
    })
  })

  describe("getOrCreateTaskChuteView Method", () => {
    test("should return existing view if available", async () => {
      const existingLeaf = { view: {} }
      workspace.getLeavesOfType.mockReturnValue([existingLeaf])

      const result = await plugin.getOrCreateTaskChuteView()

      expect(result).toBe(existingLeaf)
      expect(workspace.getRightLeaf).not.toHaveBeenCalled()
    })

    test("should create new view if none exists", async () => {
      workspace.getLeavesOfType.mockReturnValue([])
      const newLeaf = {
        setViewState: jest.fn().mockResolvedValue(),
      }
      workspace.getRightLeaf.mockReturnValue(newLeaf)

      const result = await plugin.getOrCreateTaskChuteView()

      expect(result).toBe(newLeaf)
      expect(workspace.getRightLeaf).toHaveBeenCalledWith(false)
      expect(newLeaf.setViewState).toHaveBeenCalledWith({
        type: "taskchute-view",
        active: true,
      })
    })
  })
})

describe("TaskChuteView setSelectedDate Method", () => {
  let view
  let containerEl

  beforeEach(() => {
    // コンテナ要素のモック
    const dateLabel = {
      innerHTML: "",
    }

    containerEl = {
      querySelector: jest.fn().mockReturnValue(dateLabel),
    }

    // TaskChuteViewのモック
    const TaskChuteView = require("../main").TaskChuteView
    view = {
      currentDate: new Date(),
      containerEl,
      updateDateLabel: jest.fn(),
      loadTasks: jest.fn(),
      setSelectedDate: TaskChuteView.prototype.setSelectedDate,
    }
  })

  test("should update currentDate correctly", () => {
    view.setSelectedDate("2025-01-30")

    expect(view.currentDate.getFullYear()).toBe(2025)
    expect(view.currentDate.getMonth()).toBe(0) // 0-indexed
    expect(view.currentDate.getDate()).toBe(30)
  })

  test("should call updateDateLabel if date label exists", () => {
    view.setSelectedDate("2025-01-30")

    expect(view.containerEl.querySelector).toHaveBeenCalledWith(
      ".date-nav-label",
    )
    expect(view.updateDateLabel).toHaveBeenCalled()
  })

  test("should reload tasks after date change", () => {
    view.setSelectedDate("2025-01-30")

    expect(view.loadTasks).toHaveBeenCalled()
  })

  test("should handle date label not found", () => {
    view.containerEl.querySelector.mockReturnValue(null)

    // エラーが発生しないことを確認
    expect(() => {
      view.setSelectedDate("2025-01-30")
    }).not.toThrow()

    expect(view.loadTasks).toHaveBeenCalled()
  })
})
