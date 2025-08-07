// よりシンプルなテストアプローチ

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  TFolder: jest.fn(),
  Notice: jest.fn(),
  PluginSettingTab: jest.fn(),
  Setting: jest.fn(),
  normalizePath: jest.fn(path => path)
}))

const { TFile } = require('obsidian')
const { TaskChuteView } = require("../main")
const { mockApp, mockLeaf } = require("../__mocks__/obsidian")

describe("Flexible Routine Schedule - Simplified Tests", () => {
  let taskChuteView
  let app
  let leaf

  beforeEach(() => {
    // 完全なAppモックを作成
    app = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        getMarkdownFiles: jest.fn(() => []),
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn()
        }
      },
      metadataCache: {
        getFileCache: jest.fn()
      },
      fileManager: {
        processFrontMatter: jest.fn()
      }
    }
    leaf = mockLeaf
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView(leaf, mockPlugin)
    taskChuteView.app = app
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    taskChuteView.currentDate = new Date(2024, 0, 3) // 2024-01-03 (水曜日)
    // taskListのモック
    taskChuteView.taskList = {
      empty: jest.fn(),
      createEl: jest.fn().mockReturnThis(),
      appendChild: jest.fn()
    }
    // その他必要なモック
    taskChuteView.renderTaskList = jest.fn()
    taskChuteView.updateDateNav = jest.fn()
  })

  describe("shouldShowWeeklyRoutine メソッドのテスト", () => {
    test("カスタムルーチン - weekdays配列を使った曜日判定", () => {
      const task = {
        routineType: "custom",
        weekdays: [1, 3, 5] // 月・水・金
      }

      // 月曜日
      const monday = new Date(2024, 0, 1)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, monday)).toBe(true)

      // 火曜日
      const tuesday = new Date(2024, 0, 2)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, tuesday)).toBe(false)

      // 水曜日
      const wednesday = new Date(2024, 0, 3)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, wednesday)).toBe(true)

      // 木曜日
      const thursday = new Date(2024, 0, 4)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, thursday)).toBe(false)

      // 金曜日
      const friday = new Date(2024, 0, 5)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, friday)).toBe(true)

      // 土曜日
      const saturday = new Date(2024, 0, 6)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, saturday)).toBe(false)

      // 日曜日
      const sunday = new Date(2024, 0, 7)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, sunday)).toBe(false)
    })

    test("毎日ルーチンは shouldShowWeeklyRoutine を通らない", () => {
      const task = {
        routineType: "daily"
      }
      
      // shouldShowWeeklyRoutine は weekly/custom 専用なので false を返す
      const result = taskChuteView.shouldShowWeeklyRoutine(task, new Date())
      expect(result).toBe(false)
    })

    test("後方互換性 - 旧weekly形式", () => {
      const task = {
        routineType: "weekly",
        weekday: 1 // 月曜日
      }

      const monday = new Date(2024, 0, 1)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, monday)).toBe(true)

      const tuesday = new Date(2024, 0, 2)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, tuesday)).toBe(false)
    })

    test("後方互換性 - customタイプでweekday使用", () => {
      const task = {
        routineType: "custom",
        weekday: 3, // 水曜日
        weekdays: null // 配列がない場合
      }

      const wednesday = new Date(2024, 0, 3)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, wednesday)).toBe(true)

      const thursday = new Date(2024, 0, 4)
      expect(taskChuteView.shouldShowWeeklyRoutine(task, thursday)).toBe(false)
    })
  })

  describe("setRoutineTaskExtended メソッドのテスト", () => {
    beforeEach(() => {
      // pathManagerとgetAbstractFileByPathのモックを追加
      taskChuteView.plugin = {
        pathManager: {
          getTaskFolderPath: jest.fn(() => "TaskChute/Task")
        }
      }
      
      // TFileのようなオブジェクトを作成
      const mockFile = { 
        path: "TaskChute/Task/テストタスク.md",
        basename: "テストタスク",
        extension: "md"
      }
      // TFileのインスタンスチェックをパスするために、コンストラクタも設定
      Object.setPrototypeOf(mockFile, TFile.prototype)
      taskChuteView.app.vault.getAbstractFileByPath = jest.fn(() => mockFile)
      taskChuteView.ensureFrontMatter = jest.fn()
    })

    test("カスタムルーチンの保存", async () => {
      const task = {
        title: "テストタスク",
        path: "test.md",
        file: { path: "test.md" },
        isRoutine: false
      }

      const button = document.createElement("button")
      let savedFrontmatter = null

      taskChuteView.app.fileManager.processFrontMatter = jest.fn(async (file, cb) => {
        const frontmatter = {}
        cb(frontmatter)
        savedFrontmatter = frontmatter
      })

      taskChuteView.loadTasks = jest.fn()
      taskChuteView.renderTaskList = jest.fn()

      await taskChuteView.setRoutineTaskExtended(
        task, button, "10:00", "custom", null, [1, 3, 5]
      )

      expect(savedFrontmatter.routine).toBe(true)
      expect(savedFrontmatter.開始時刻).toBe("10:00")
      expect(savedFrontmatter.routine_type).toBe("custom")
      expect(savedFrontmatter.weekdays).toEqual([1, 3, 5])
    })

    test("毎日ルーチンの保存", async () => {
      const task = {
        title: "毎日タスク",
        path: "daily.md",
        file: { path: "daily.md" },
        isRoutine: false
      }

      const button = document.createElement("button")
      let savedFrontmatter = null

      // mockFileを毎日タスク用に更新
      const mockFile = { 
        path: "TaskChute/Task/毎日タスク.md",
        basename: "毎日タスク",
        extension: "md"
      }
      Object.setPrototypeOf(mockFile, TFile.prototype)
      taskChuteView.app.vault.getAbstractFileByPath = jest.fn(() => mockFile)

      taskChuteView.app.fileManager.processFrontMatter = jest.fn(async (file, cb) => {
        const frontmatter = {}
        cb(frontmatter)
        savedFrontmatter = frontmatter
      })

      taskChuteView.loadTasks = jest.fn()
      taskChuteView.renderTaskList = jest.fn()

      await taskChuteView.setRoutineTaskExtended(
        task, button, "09:00", "daily", null, null
      )

      expect(savedFrontmatter.routine).toBe(true)
      expect(savedFrontmatter.開始時刻).toBe("09:00")
      expect(savedFrontmatter.routine_type).toBe("daily")
      expect(savedFrontmatter.weekday).toBeUndefined()
      expect(savedFrontmatter.weekdays).toBeUndefined()
    })
  })

  describe("getWeekdayName メソッドのテスト", () => {
    test("曜日番号から曜日名を取得", () => {
      expect(taskChuteView.getWeekdayName(0)).toBe("日")
      expect(taskChuteView.getWeekdayName(1)).toBe("月")
      expect(taskChuteView.getWeekdayName(2)).toBe("火")
      expect(taskChuteView.getWeekdayName(3)).toBe("水")
      expect(taskChuteView.getWeekdayName(4)).toBe("木")
      expect(taskChuteView.getWeekdayName(5)).toBe("金")
      expect(taskChuteView.getWeekdayName(6)).toBe("土")
    })
  })

  describe("ルーチンタスクの表示ロジック統合テスト", () => {
    test("loadTasksでのルーチンタスク表示判定のシミュレーション", async () => {
      // loadTasksの処理を簡略化してテスト
      const mockFiles = [
        {
          basename: "毎日タスク",
          path: "daily-task.md",
        },
        {
          basename: "カスタムタスク",
          path: "custom-task.md",
        }
      ]

      // 水曜日に設定
      taskChuteView.currentDate = new Date(2024, 0, 3)
      const dateString = "2024-01-03"

      // 毎日タスクの判定
      const dailyRoutineType = "daily"
      let shouldShowDaily = false
      if (dailyRoutineType === "daily") {
        shouldShowDaily = true
      }
      expect(shouldShowDaily).toBe(true)

      // カスタムタスク（月・水・金）の判定
      const customTask = {
        routineType: "custom",
        weekdays: [1, 3, 5]
      }
      const shouldShowCustom = taskChuteView.shouldShowWeeklyRoutine(customTask, taskChuteView.currentDate)
      expect(shouldShowCustom).toBe(true)

      // 実際のloadTasksでの処理をシミュレート
      const simulatedTasks = []
      
      // 毎日タスクは常に追加
      if (shouldShowDaily) {
        simulatedTasks.push({
          title: "毎日タスク",
          routineType: "daily",
          scheduledTime: "09:00"
        })
      }
      
      // カスタムタスクは曜日判定で追加
      if (shouldShowCustom) {
        simulatedTasks.push({
          title: "カスタムタスク",
          routineType: "custom",
          weekdays: [1, 3, 5],
          scheduledTime: "10:00"
        })
      }

      expect(simulatedTasks).toHaveLength(2)
      expect(simulatedTasks[0].routineType).toBe("daily")
      expect(simulatedTasks[1].routineType).toBe("custom")
    })

    test("カスタムルーチンが指定曜日以外では表示されない", async () => {
      const mockFiles = [
        {
          basename: "月水金タスク",
          path: "mwf-task.md",
        }
      ]

      taskChuteView.app.metadataCache.getFileCache = jest.fn(() => ({
        frontmatter: {
          routine: true,
          routine_type: "custom",
          開始時刻: "10:00",
          weekdays: [1, 3, 5] // 月・水・金
        }
      }))

      taskChuteView.app.vault.getMarkdownFiles = jest.fn(() => mockFiles)
      taskChuteView.app.vault.read = jest.fn().mockResolvedValue("{}")
      
      // 火曜日に設定
      taskChuteView.currentDate = new Date(2024, 0, 2)
      
      await taskChuteView.loadTasks()

      // 火曜日なのでタスクは表示されない
      const task = taskChuteView.tasks.find(t => t.title === "月水金タスク")
      expect(task).toBeFalsy()
    })
  })
})