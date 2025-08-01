const { Plugin, ItemView, WorkspaceLeaf, TFile, Notice } = require("obsidian")

// モック設定
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

// TaskChuteView クラスをインポート
const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

describe("Non-Routine Task Display Bug", () => {
  let taskChuteView
  let mockApp
  let mockLeaf
  let mockVaultAdapter

  beforeEach(() => {
    // ファイルシステムのモック
    const mockFileSystem = {}

    mockVaultAdapter = {
      exists: jest.fn((path) => Promise.resolve(!!mockFileSystem[path])),
      read: jest.fn((path) => Promise.resolve(mockFileSystem[path] || "")),
      write: jest.fn((path, content) => {
        mockFileSystem[path] = content
        return Promise.resolve()
      }),
      createFolder: jest.fn(() => Promise.resolve()),
      getFullPath: jest.fn((path) => `/mock/path/${path}`),
    }

    // fsモックの設定
    const mockFs = {
      statSync: jest.fn((path) => ({
        birthtime: new Date("2024-07-08T00:00:00.000Z"), // ファイル作成日を7/8に設定
      })),
    }

    // requireをモック化
    jest.doMock("fs", () => mockFs)

    // モックアプリケーションの設定
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        create: jest.fn(),
        modify: jest.fn(),
        getAbstractFileByPath: jest.fn(),
        adapter: mockVaultAdapter,
        createFolder: jest.fn(),
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

    // モックリーフの設定
    mockLeaf = {
      containerEl: {
        children: [
          {},
          {
            empty: jest.fn(),
            createEl: jest.fn().mockReturnValue({
              empty: jest.fn(),
              createEl: jest.fn().mockReturnValue({
                addEventListener: jest.fn(),
                style: {},
                textContent: "",
                innerHTML: "",
                setAttribute: jest.fn(),
                getAttribute: jest.fn(),
                classList: {
                  add: jest.fn(),
                  remove: jest.fn(),
                  contains: jest.fn(),
                },
              }),
              addEventListener: jest.fn(),
              style: {},
              textContent: "",
              innerHTML: "",
            }),
          },
        ],
      },
    }

    // TaskChuteView インスタンスを作成
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      },
      routineAliasManager: {
        getAliases: jest.fn(() => []),
        findCurrentName: jest.fn(),
        addAlias: jest.fn()
      }
    }

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = mockApp

    // 必要なプロパティを初期化
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    taskChuteView.currentDate = new Date("2024-07-08")
    taskChuteView.taskList = { empty: jest.fn() }

    // renderTaskListとmanageTimersをモック化
    taskChuteView.renderTaskList = jest.fn()
    taskChuteView.manageTimers = jest.fn()

    // startInstanceメソッドのモック
    taskChuteView.startInstance = jest.fn(async (inst) => {
      if (inst) {
        inst.state = "running"
        inst.startTime = new Date()
        await taskChuteView.saveRunningTasksState()
      }
    })

    // saveRunningTasksStateメソッドのモック
    taskChuteView.saveRunningTasksState = jest.fn(async () => {
      const runningInstances = taskChuteView.taskInstances.filter(
        (inst) => inst && inst.state === "running",
      )

      const dataToSave = runningInstances.map((inst) => {
        const today = new Date(inst.startTime)
        const y = today.getFullYear()
        const m = (today.getMonth() + 1).toString().padStart(2, "0")
        const d = today.getDate().toString().padStart(2, "0")
        const dateString = `${y}-${m}-${d}`

        return {
          date: dateString,
          taskTitle: inst.task.title,
          taskPath: inst.task.path,
          startTime: inst.startTime.toISOString(),
          taskDescription: inst.task.description || "",
          slotKey: inst.slotKey,
          isRoutine: inst.task.isRoutine || false,
          taskId: inst.task.id,
        }
      })

      const dataPath = "TaskChute/Log/running-task.json"
      const content = JSON.stringify(dataToSave, null, 2)
      mockFileSystem[dataPath] = content
    })

    // stopInstanceメソッドのモック
    taskChuteView.stopInstance = jest.fn(async (inst) => {
      if (inst) {
        inst.state = "done"
        inst.stopTime = new Date()
        // running-task.jsonから除外
        const dataPath =
          "TaskChute/Log/running-task.json"
        const runningTasksData = JSON.parse(mockFileSystem[dataPath] || "[]")
        const filteredData = runningTasksData.filter(
          (data) => data.taskPath !== inst.task.path,
        )
        mockFileSystem[dataPath] = JSON.stringify(filteredData)
      }
    })

    // checkAllTasksCompletedメソッドのモック（DOM操作を避ける）
    taskChuteView.checkAllTasksCompleted = jest.fn()

    // showCompletionCelebrationメソッドのモック（DOM操作を避ける）
    taskChuteView.showCompletionCelebration = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.resetModules()
  })

  describe("Non-routine task display across multiple days", () => {
    test("should NOT display non-routine task on next day after execution", async () => {
      // 非ルーチンタスクファイルを作成
      const nonRoutineTaskFile = {
        path: "Tasks/非ルーチンタスクA.md",
        basename: "非ルーチンタスクA",
        extension: "md",
      }

      // 7/8にタスクを作成
      mockApp.vault.getMarkdownFiles.mockReturnValue([nonRoutineTaskFile])
      mockApp.vault.read.mockResolvedValue(`
# 非ルーチンタスクA

#task

タスクの説明
`)

      // メタデータキャッシュ（ルーチンでない）
      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: {
          routine: false,
        },
      })

      // 7/8でタスクを実行開始
      taskChuteView.currentDate = new Date("2024-07-08")
      await taskChuteView.loadTasks()

      // タスクが表示されることを確認
      expect(taskChuteView.taskInstances.length).toBeGreaterThan(0)
      const taskInstance = taskChuteView.taskInstances[0]
      expect(taskInstance.task.title).toBe("非ルーチンタスクA")

      // タスクを実行開始
      await taskChuteView.startInstance(taskInstance)

      // 実行中タスクの状態を保存
      await taskChuteView.saveRunningTasksState()

      // 実行中タスクが保存されていることを確認
      const runningTaskData = await mockVaultAdapter.read(
        "TaskChute/Log/running-task.json",
      )
      const runningTasks = JSON.parse(runningTaskData)
      expect(runningTasks).toHaveLength(1)
      expect(runningTasks[0].taskPath).toBe("Tasks/非ルーチンタスクA.md")

      // 7/9に日付を変更
      taskChuteView.currentDate = new Date("2024-07-09")
      taskChuteView.tasks = []
      taskChuteView.taskInstances = []

      // 7/9でタスクリストを読み込み
      await taskChuteView.loadTasks()

      // 🔴 現在のバグ：非ルーチンタスクが7/9にも表示される
      // このテストは現在FAIL（期待値と実際の値が異なる）
      const taskInstancesOn709 = taskChuteView.taskInstances.filter(
        (inst) => inst.task.title === "非ルーチンタスクA",
      )

      // 本来は0であるべきだが、現在のバグでは1になる
      expect(taskInstancesOn709.length).toBe(0) // このテストは現在FAIL
    })

    test("should display non-routine task only on execution date", async () => {
      // 非ルーチンタスクファイルを作成
      const nonRoutineTaskFile = {
        path: "Tasks/非ルーチンタスクB.md",
        basename: "非ルーチンタスクB",
        extension: "md",
      }

      mockApp.vault.getMarkdownFiles.mockReturnValue([nonRoutineTaskFile])
      mockApp.vault.read.mockResolvedValue(`
# 非ルーチンタスクB

#task

タスクの説明
`)

      // メタデータキャッシュ（ルーチンでない）
      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: {
          routine: false,
        },
      })

      // 7/8でタスクを実行開始
      taskChuteView.currentDate = new Date("2024-07-08")
      await taskChuteView.loadTasks()

      const taskInstance = taskChuteView.taskInstances[0]
      await taskChuteView.startInstance(taskInstance)

      // 7/8でタスクを完了
      await taskChuteView.stopInstance(taskInstance)

      // デイリーノートに実行履歴が保存されることをモック
      const dailyNoteContent = `# 2024-07-08 のタスク記録

| タスク | 開始時刻 | 終了時刻 | 実行時間 | 時間帯 |
|-------|----------|----------|----------|--------|
| 非ルーチンタスクB | 10:00:00 | 10:30:00 | 00:30:00 | none |
`
      mockApp.vault.getAbstractFileByPath.mockReturnValue({
        path: "07_Daily/2024-07-08.md",
      })
      mockApp.vault.read.mockResolvedValue(dailyNoteContent)

      // 7/9に日付を変更
      taskChuteView.currentDate = new Date("2024-07-09")
      taskChuteView.tasks = []
      taskChuteView.taskInstances = []

      // 7/9のデイリーノートは存在しない
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === "07_Daily/2024-07-09.md") {
          return null
        }
        return { path: "07_Daily/2024-07-08.md" }
      })

      // 7/9でタスクリストを読み込み
      await taskChuteView.loadTasks()

      // 7/9には非ルーチンタスクが表示されないはず
      const taskInstancesOn709 = taskChuteView.taskInstances.filter(
        (inst) => inst.task.title === "非ルーチンタスクB",
      )

      expect(taskInstancesOn709.length).toBe(0)
    })

    test("should reproduce the exact bug scenario", async () => {
      // 非ルーチンタスクファイルを作成
      const nonRoutineTaskFile = {
        path: "Tasks/タスクA.md",
        basename: "タスクA",
        extension: "md",
      }

      mockApp.vault.getMarkdownFiles.mockReturnValue([nonRoutineTaskFile])
      mockApp.vault.read.mockResolvedValue(`
# タスクA

#task

非ルーチンタスクの説明
`)

      // メタデータキャッシュ（ルーチンでない）
      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: {
          routine: false,
        },
      })

      // === 7/8でタスクを実行開始 ===
      taskChuteView.currentDate = new Date("2024-07-08")
      await taskChuteView.loadTasks()

      const taskInstance = taskChuteView.taskInstances[0]
      expect(taskInstance.task.title).toBe("タスクA")

      // タスクを実行開始
      await taskChuteView.startInstance(taskInstance)

      // === 7/9でタスクリストを確認 ===
      taskChuteView.currentDate = new Date("2024-07-09")
      taskChuteView.tasks = []
      taskChuteView.taskInstances = []

      await taskChuteView.loadTasks()

      // 🔴 バグ：7/9にもタスクAが表示される
      const taskInstancesOn709 = taskChuteView.taskInstances.filter(
        (inst) => inst.task.title === "タスクA",
      )
      expect(taskInstancesOn709.length).toBe(0) // このテストは現在FAIL

      // === 7/10でタスクリストを確認 ===
      taskChuteView.currentDate = new Date("2024-07-10")
      taskChuteView.tasks = []
      taskChuteView.taskInstances = []

      await taskChuteView.loadTasks()

      // 🔴 バグ：7/10にもタスクAが表示される
      const taskInstancesOn710 = taskChuteView.taskInstances.filter(
        (inst) => inst.task.title === "タスクA",
      )
      expect(taskInstancesOn710.length).toBe(0) // このテストは現在FAIL

      // === 7/8に戻ってタスクを終了 ===
      taskChuteView.currentDate = new Date("2024-07-08")
      taskChuteView.tasks = []
      taskChuteView.taskInstances = []

      await taskChuteView.loadTasks()
      const taskInstanceBack = taskChuteView.taskInstances[0]
      await taskChuteView.stopInstance(taskInstanceBack)

      // === 7/9で再度確認 ===
      taskChuteView.currentDate = new Date("2024-07-09")
      taskChuteView.tasks = []
      taskChuteView.taskInstances = []

      await taskChuteView.loadTasks()

      // ✅ 修正後：7/9にはタスクAが表示されない
      const taskInstancesAfterStop = taskChuteView.taskInstances.filter(
        (inst) => inst.task.title === "タスクA",
      )
      expect(taskInstancesAfterStop.length).toBe(0)
    })
  })
})
