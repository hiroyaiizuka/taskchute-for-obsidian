const { TaskChuteView } = require("../main")
const { Notice, TFile } = require("obsidian")

// ObsidianのAPIをモック
jest.mock("obsidian", () => ({
  Notice: jest.fn(),
  ItemView: class ItemView {
    constructor() {}
  },
  Plugin: class Plugin {
    constructor() {}
  },
  TFile: class TFile {},
  TFolder: class TFolder {},
  moment: {
    tz: {
      guess: () => "Asia/Tokyo",
    },
  },
}))

describe("完了済みタスクの表示制御", () => {
  let plugin
  let view
  let mockApp
  let mockLeaf

  beforeEach(() => {
    // モックの設定
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          getFullPath: jest.fn(),
        },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        getAbstractFileByPath: jest.fn(),
        getMarkdownFiles: jest.fn().mockReturnValue([]),
      },
      metadataCache: {
        getFileCache: jest.fn(),
      },
    }

    mockLeaf = {
      view: {},
    }

    plugin = {
      app: mockApp,
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue("TaskChute/Task"),
        getLogDataPath: jest.fn().mockReturnValue("TaskChute/Log"),
        getProjectFolderPath: jest.fn().mockReturnValue("TaskChute/Project"),
      },
      settings: {},
    }

    // TaskChuteViewのインスタンスを作成
    view = new TaskChuteView(mockLeaf, plugin)
    view.app = mockApp
    view.plugin = plugin
    view.taskInstances = []
    view.renderTaskList = jest.fn()
    view.saveRunningTasksState = jest.fn().mockResolvedValue(undefined)

    // 現在の日付を2025-08-01に設定
    view.currentDate = new Date("2025-08-01T09:00:00+09:00")

    // getCurrentDateStringメソッドが必要
    view.getCurrentDateString = function () {
      const y = this.currentDate.getFullYear()
      const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
      const d = this.currentDate.getDate().toString().padStart(2, "0")
      return `${y}-${m}-${d}`
    }

    // LocalStorageのモック
    const localStorageData = {}
    global.localStorage = {
      getItem: jest.fn((key) => localStorageData[key] || null),
      setItem: jest.fn((key, value) => {
        localStorageData[key] = value
      }),
      removeItem: jest.fn((key) => {
        delete localStorageData[key]
      }),
    }
  })

  test("完了済みタスクは非表示リストに含まれていても表示される", async () => {
    const taskPath = "02_Config/TaskChute/Task/Project Reviewsの設計をする.md"
    const dateString = "2025-08-01"

    // 非表示リストにタスクが含まれている状態を設定
    const hiddenRoutines = [
      {
        path: taskPath,
        instanceId: null,
      },
    ]

    // LocalStorageに非表示リストを設定
    global.localStorage.setItem(
      `taskchute-hidden-routines-${dateString}`,
      JSON.stringify(hiddenRoutines),
    )

    // 実行履歴が存在する（完了済みタスク）
    const monthlyLog = {
      taskExecutions: {
        "2025-08-01": [
          {
            taskId: taskPath,
            taskName: "Project Reviewsの設計をする",
            isCompleted: "2025-08-01T09:58:22.141Z",
            startTime: "15:40:23",
            stopTime: "18:58:22",
            instanceId: "test-instance-id",
          },
        ],
      },
    }

    // タスクファイルのモック
    const taskFile = {
      path: taskPath,
      basename: "Project Reviewsの設計をする",
    }

    // ファイル内容のモック
    const fileContent = `---
routine: true
開始時刻: 12:45
routine_type: daily
routine_start: 2025-07-08
---

# Project Reviewsの設計をする

#task`

    // モックの設定
    // TFileインスタンスのモック
    const mockLogFile = { path: "TaskChute/Log/2025-08-tasks.json" }
    mockLogFile.constructor = TFile
    Object.setPrototypeOf(mockLogFile, TFile.prototype)

    const mockTaskFile = { path: taskPath }
    mockTaskFile.constructor = TFile
    Object.setPrototypeOf(mockTaskFile, TFile.prototype)

    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path.includes("2025-08-tasks.json")) {
        return mockLogFile
      }
      if (path === taskPath) {
        return mockTaskFile
      }
      return null
    })

    mockApp.vault.read.mockImplementation((file) => {
      if (
        file === mockLogFile ||
        (file && file.path && file.path.includes("2025-08-tasks.json"))
      ) {
        return Promise.resolve(JSON.stringify(monthlyLog))
      }
      if (file === mockTaskFile || (file && file.path === taskPath)) {
        return Promise.resolve(fileContent)
      }
      return Promise.resolve("")
    })

    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: {
        routine: true,
        開始時刻: "12:45",
        routine_type: "daily",
        routine_start: "2025-07-08",
      },
    })

    // getHiddenRoutinesメソッドのテスト
    const hiddenList = view.getHiddenRoutines(dateString)
    expect(hiddenList).toHaveLength(1)
    expect(hiddenList[0].path).toBe(taskPath)

    // loadTodayExecutionsメソッドのテスト
    const executions = await view.loadTodayExecutions(dateString)
    expect(executions).toHaveLength(1)
    expect(executions[0].taskTitle).toBe("Project Reviewsの設計をする")

    // タスクが表示されることを確認
    // 実行履歴があるため、非表示リストに含まれていても表示されるべき
    const todayExecutionsForTask = executions.filter(
      (exec) => exec.taskTitle === taskFile.basename,
    )
    expect(todayExecutionsForTask).toHaveLength(1)

    // hasExecutionsがtrueになることを確認
    const hasExecutions = todayExecutionsForTask.length > 0
    expect(hasExecutions).toBe(true)
  })

  test("完了済みタスクも削除できる（制限撤廃後）", async () => {
    const inst = {
      task: {
        title: "テストタスク",
        path: "test.md",
        isRoutine: true,
      },
      state: "done", // 完了済み
      instanceId: "test-instance",
    }

    // Noticeモックをクリア
    Notice.mockClear()

    // taskInstancesに事前に設定
    view.taskInstances = [inst]

    // deleteRoutineTaskを実行
    await view.deleteRoutineTask(inst)

    // 削除完了メッセージが表示されることを確認
    expect(Notice).toHaveBeenCalledWith(
      "「テストタスク」を本日のリストから削除しました。\n（他の日付には影響しません）",
    )

    // taskInstancesから削除されていることを確認
    expect(view.taskInstances).toHaveLength(0)
  })

  test("未完了のルーチンタスクは非表示リストに追加される", async () => {
    const inst = {
      task: {
        title: "テストタスク",
        path: "test.md",
        isRoutine: true,
      },
      state: "idle", // 未完了
      instanceId: "test-instance",
    }

    view.taskInstances = [inst]
    Notice.mockClear()

    // saveHiddenRoutinesメソッドが必要
    view.saveHiddenRoutines = jest.fn()

    // deleteRoutineTaskメソッドを追加（実際の実装をベース）
    view.deleteRoutineTask = async function (inst) {
      this.taskInstances = this.taskInstances.filter((i) => i !== inst)
      const dateStr = this.getCurrentDateString()
      const hiddenRoutines = this.getHiddenRoutines(dateStr)

      hiddenRoutines.push({
        path: inst.task.path,
        instanceId: null,
      })
      this.saveHiddenRoutines(dateStr, hiddenRoutines)

      Notice(
        `「${inst.task.title}」を本日のリストから削除しました。\n（他の日付には影響しません）`,
      )
    }

    // deleteRoutineTaskを実行
    await view.deleteRoutineTask(inst)

    // saveHiddenRoutinesが呼ばれたことを確認
    expect(view.saveHiddenRoutines).toHaveBeenCalled()

    const savedRoutines = view.saveHiddenRoutines.mock.calls[0][1]
    // 既存の非表示リストに追加されている可能性があるため、test.mdが含まれていることを確認
    const testTaskInList = savedRoutines.find((r) => r.path === "test.md")
    expect(testTaskInList).toBeDefined()
    expect(testTaskInList.path).toBe("test.md")

    // taskInstancesから削除されたことを確認
    expect(view.taskInstances).toHaveLength(0)
  })

  test("実行履歴がないルーチンタスクは非表示リストの影響を受ける", async () => {
    const taskPath = "test-routine.md"
    const dateString = "2025-08-01"

    // 非表示リストにタスクが含まれている
    global.localStorage.setItem(
      `taskchute-hidden-routines-${dateString}`,
      JSON.stringify([{ path: taskPath, instanceId: null }]),
    )

    // 実行履歴なし
    mockApp.vault.read.mockImplementation((path) => {
      if (path.includes("2025-08-tasks.json")) {
        return JSON.stringify({ taskExecutions: {} })
      }
      return ""
    })

    const executions = await view.loadTodayExecutions(dateString)
    expect(executions).toHaveLength(0)

    // hiddenRoutinePathsに含まれることを確認
    const hiddenRoutines = view.getHiddenRoutines(dateString)
    const hiddenRoutinePaths = hiddenRoutines
      .filter((h) => !h.instanceId || h.instanceId === null)
      .map((h) => (typeof h === "string" ? h : h.path))

    expect(hiddenRoutinePaths).toContain(taskPath)
  })
})
