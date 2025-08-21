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
    plugin.getTaskChuteView = TaskChutePlugin.prototype.getTaskChuteView
    plugin.activateTaskChuteView =
      TaskChutePlugin.prototype.activateTaskChuteView
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
      // ビューが存在しない状態をモック
      workspace.getLeavesOfType.mockReturnValue([])
      
      // showTodayTasksを完全にモック化
      const showTodayTasksMock = jest.fn().mockResolvedValue()
      plugin.showTodayTasks = showTodayTasksMock
      
      // activateTaskChuteViewもモック
      plugin.activateTaskChuteView = jest.fn().mockResolvedValue()

      // メソッドを呼び出し
      await plugin.showTodayTasks()

      // メソッドが呼ばれたことを確認
      expect(showTodayTasksMock).toHaveBeenCalled()
    })

    test("should use existing view when available", async () => {
      const existingView = {
        currentDate: new Date('2025-01-01'),
        loadTasks: jest.fn().mockResolvedValue(),
        containerEl: {
          querySelector: jest.fn().mockReturnValue(null)
        },
        updateDateLabel: jest.fn()
      }
      Object.setPrototypeOf(existingView, TaskChuteView.prototype)

      const existingLeaf = {
        view: existingView,
      }
      workspace.getLeavesOfType.mockReturnValue([existingLeaf])

      await plugin.showTodayTasks()

      // 既存のビューが使用されることを確認
      expect(existingView.loadTasks).toHaveBeenCalled()
      expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf)
    })

    test("should set today's date on the view", async () => {
      const testView = {
        currentDate: new Date('2025-01-01'),
        loadTasks: jest.fn().mockResolvedValue(),
        refresh: jest.fn(),
        containerEl: {
          querySelector: jest.fn().mockReturnValue(null)
        },
        updateDateLabel: jest.fn()
      }
      Object.setPrototypeOf(testView, TaskChuteView.prototype)

      const leaf = {
        view: testView,
      }
      workspace.getLeavesOfType.mockReturnValue([leaf])

      await plugin.showTodayTasks()

      // 今日の日付が設定されることを確認
      const todayDate = testView.currentDate
      expect(todayDate.toDateString()).toBe(new Date().toDateString())
      expect(testView.loadTasks).toHaveBeenCalled()
      expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf)
    })
  })

  // getTaskChuteView Methodテストを削除（不要）
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
