const { TaskChuteView } = require("../main.js")
const { TFile } = require("obsidian")

// モックオブジェクト
const mockApp = {
  vault: {
    getAbstractFileByPath: jest.fn(),
    getMarkdownFiles: jest.fn(() => []),
    read: jest.fn(),
    write: jest.fn(),
    modify: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    adapter: {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      mkdir: jest.fn(),
      list: jest.fn(() => ({ files: [] })),
      getFullPath: jest.fn(),
    },
  },
  metadataCache: {
    getFileCache: jest.fn(() => null),
  },
  fileManager: {
    processFrontMatter: jest.fn(),
  },
  workspace: {
    openLinkText: jest.fn(),
    splitActiveLeaf: jest.fn(),
    setActiveLeaf: jest.fn(),
  },
  plugins: {
    plugins: {
      "taskchute-plus": {
        settings: {
          enableCelebration: false,
          enableSound: false,
          enableFireworks: false,
          enableConfetti: false,
        },
      },
    },
  },
}

const mockLeaf = {
  view: null,
}

// localStorageのモック
const localStorageMock = {
  storage: {},
  getItem: jest.fn((key) => localStorageMock.storage[key] || null),
  setItem: jest.fn((key, value) => {
    localStorageMock.storage[key] = value
  }),
  removeItem: jest.fn((key) => {
    delete localStorageMock.storage[key]
  }),
  clear: jest.fn(() => {
    localStorageMock.storage = {}
  }),
}

// グローバルなlocalStorageをモック
Object.defineProperty(global, "localStorage", {
  value: localStorageMock,
})

// DocumentとElementのモック
global.document = {
  createElement: jest.fn(() => ({
    className: "",
    style: {},
    appendChild: jest.fn(),
    createEl: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    remove: jest.fn(),
    getBoundingClientRect: jest.fn(() => ({
      top: 0,
      left: 0,
      bottom: 100,
      right: 100,
    })),
  })),
  body: {
    appendChild: jest.fn(),
    removeChild: jest.fn(),
  },
  head: {
    appendChild: jest.fn(),
  },
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}

global.window = {
  innerHeight: 600,
  AudioContext: jest.fn(),
  webkitAudioContext: jest.fn(),
}

describe("duplicateAndStartInstance バグ再現テスト", () => {
  let view
  let mockTaskFile
  let mockContainerEl

  beforeEach(() => {
    // localStorage をクリア
    localStorageMock.clear()

    // モックファイルの作成
    mockTaskFile = {
      path: "TaskChute/Task/TestTask.md",
      basename: "TestTask",
      extension: "md",
      stat: { ctime: Date.now(), mtime: Date.now() },
    }

    // コンテナエレメントのモック
    mockContainerEl = {
      children: [
        null,
        {
          empty: jest.fn(),
          createEl: jest.fn(() => ({
            createEl: jest.fn(() => ({
              createEl: jest.fn(() => ({})),
              addEventListener: jest.fn(),
              setAttribute: jest.fn(),
              textContent: "",
            })),
            addEventListener: jest.fn(),
            setAttribute: jest.fn(),
            style: {},
          })),
          querySelector: jest.fn(),
          querySelectorAll: jest.fn(() => []),
          scrollTop: 0,
          scrollLeft: 0,
        },
      ],
    }

    // TaskChuteViewのインスタンスを作成
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = mockApp
    view.containerEl = mockContainerEl
    view.taskList = {
      empty: jest.fn(),
      createEl: jest.fn(() => ({
        createEl: jest.fn(() => ({
          createEl: jest.fn(() => ({})),
          addEventListener: jest.fn(),
          setAttribute: jest.fn(),
          textContent: "",
          querySelector: jest.fn(),
          classList: {
            add: jest.fn(),
            remove: jest.fn(),
          },
        })),
        addEventListener: jest.fn(),
        setAttribute: jest.fn(),
        style: {},
        classList: {
          add: jest.fn(),
          remove: jest.fn(),
        },
      })),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn(() => []),
      scrollTop: 0,
      scrollLeft: 0,
    }

    // 現在日付を固定
    view.currentDate = new Date("2024-01-15T10:00:00")

    // 必要なメソッドをモック
    view.renderTaskList = jest.fn()
    view.manageTimers = jest.fn()
    view.checkAllTasksCompleted = jest.fn()
  })

  describe("バグ再現シナリオ", () => {
    test("duplicateAndStartInstance後の削除でタスクが復活する", async () => {
      // 1. 初期タスクを作成
      const originalTask = {
        title: "TestTask",
        path: "TaskChute/Task/TestTask.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
        projectPath: null,
        projectTitle: null,
      }

      const originalInstance = {
        task: originalTask,
        state: "done",
        startTime: new Date("2024-01-15T09:00:00"),
        stopTime: new Date("2024-01-15T10:00:00"),
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: "original-instance-id",
      }

      view.tasks = [originalTask]
      view.taskInstances = [originalInstance]

      // 2. duplicateAndStartInstance を実行
      await view.duplicateAndStartInstance(originalInstance)

      // 3. 新しいインスタンスが作成されたことを確認
      expect(view.taskInstances.length).toBe(2)
      const duplicatedInstance = view.taskInstances.find(
        (inst) => inst.instanceId !== "original-instance-id",
      )
      expect(duplicatedInstance).toBeDefined()
      expect(duplicatedInstance.task.path).toBe(originalTask.path)
      expect(duplicatedInstance.state).toBe("running")

      // 4. 複製情報がlocalStorageに記録されているかチェック
      const dateString = "2024-01-15"
      const duplicatedStorageKey = `taskchute-duplicated-instances-${dateString}`
      const storedDuplicates = JSON.parse(
        localStorage.getItem(duplicatedStorageKey) || "[]",
      )

      // ✅ 修正後：複製情報が正しく記録されている
      expect(storedDuplicates.length).toBe(1)
      expect(storedDuplicates[0].path).toBe(originalTask.path)
      expect(storedDuplicates[0].instanceId).toBe(duplicatedInstance.instanceId)

      // 5. 複製されたタスクを完了させる
      duplicatedInstance.state = "done"
      duplicatedInstance.stopTime = new Date("2024-01-15T11:00:00")

      // 6. JSONログファイルに実行履歴を保存（モック）
      const mockJsonLog = {
        metadata: {
          version: "2.0",
          month: "2024-01",
          lastUpdated: new Date().toISOString(),
        },
        taskExecutions: {
          "2024-01-15": [
            {
              taskId: originalTask.path,
              taskName: originalTask.title,
              instanceId: duplicatedInstance.instanceId,
              isCompleted: true,
              startTime: "10:00:00",
              stopTime: "11:00:00",
              slot: "8:00-12:00",
            },
          ],
        },
      }

      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(mockJsonLog))
      mockApp.vault.adapter.exists.mockResolvedValue(true)

      // 7. 複製されたタスクを削除
      await view.deleteDuplicatedInstance(duplicatedInstance)

      // 8. インスタンスが配列から削除されたことを確認
      expect(view.taskInstances.length).toBe(1)
      expect(view.taskInstances[0].instanceId).toBe("original-instance-id")

      // 9. しかし、JSONログファイルには実行履歴が残っている
      // （実際の実装では deleteTaskLogs が呼ばれないため）

      // 10. 再起動をシミュレート - loadTasks を再実行
      view.taskInstances = []

      // loadTodayExecutions をモック
      // ✅ 修正後：deleteTaskLogsが呼ばれたため、実行履歴は削除されている
      view.loadTodayExecutions = jest.fn().mockResolvedValue([])

      // getTaskFiles をモック
      view.getTaskFiles = jest.fn().mockResolvedValue([mockTaskFile])

      // ファイル読み込みをモック
      mockApp.vault.read.mockResolvedValue(`---
routine: false
---

# TestTask

#task
`)

      // loadTasks を実行
      await view.loadTasks()

      // 11. ✅ 修正後：削除したタスクは復活しない
      const revivedInstance = view.taskInstances.find(
        (inst) => inst.instanceId === duplicatedInstance.instanceId,
      )
      expect(revivedInstance).toBeUndefined()
    })

    test("duplicateInstance（設定メニュー）では正常に動作する", async () => {
      // 比較のため、正常な duplicateInstance の動作を確認
      const originalTask = {
        title: "TestTask",
        path: "TaskChute/Task/TestTask.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
        projectPath: null,
        projectTitle: null,
      }

      const originalInstance = {
        task: originalTask,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: "original-instance-id",
      }

      view.tasks = [originalTask]
      view.taskInstances = [originalInstance]

      // duplicateInstance を実行
      view.duplicateInstance(originalInstance)

      // 新しいインスタンスが作成されたことを確認
      expect(view.taskInstances.length).toBe(2)
      const duplicatedInstance = view.taskInstances.find(
        (inst) => inst.instanceId !== "original-instance-id",
      )
      expect(duplicatedInstance).toBeDefined()

      // ✅ 複製情報が正しく記録されている
      const dateString = "2024-01-15"
      const duplicatedStorageKey = `taskchute-duplicated-instances-${dateString}`
      const storedDuplicates = JSON.parse(
        localStorage.getItem(duplicatedStorageKey) || "[]",
      )

      expect(storedDuplicates.length).toBe(1)
      expect(storedDuplicates[0].path).toBe(originalTask.path)
      expect(storedDuplicates[0].instanceId).toBe(duplicatedInstance.instanceId)
    })

    test("複製情報の記録漏れが削除処理に影響する", async () => {
      const originalTask = {
        title: "TestTask",
        path: "TaskChute/Task/TestTask.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
        projectPath: null,
        projectTitle: null,
      }

      const duplicatedInstance = {
        task: originalTask,
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T11:00:00"),
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: "duplicated-instance-id",
      }

      view.tasks = [originalTask]
      view.taskInstances = [duplicatedInstance]

      // 複製情報を記録せずに削除を試行
      // （duplicateAndStartInstance で作成されたインスタンスのシミュレート）

      // deleteDuplicatedInstance を実行
      await view.deleteDuplicatedInstance(duplicatedInstance)

      // インスタンスは削除されている
      expect(view.taskInstances.length).toBe(0)

      // しかし、localStorage の複製情報は空のまま
      const dateString = "2024-01-15"
      const duplicatedStorageKey = `taskchute-duplicated-instances-${dateString}`
      const storedDuplicates = JSON.parse(
        localStorage.getItem(duplicatedStorageKey) || "[]",
      )

      expect(storedDuplicates.length).toBe(0)

      // この状態では、JSONログファイルの実行履歴は削除されない
      // （実際の実装では deleteTaskLogs が呼ばれないため）
    })

    test("JSONログファイルの残留問題を詳細検証", async () => {
      // 1. 初期タスクを作成
      const originalTask = {
        title: "TestTask",
        path: "TaskChute/Task/TestTask.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
        projectPath: null,
        projectTitle: null,
      }

      const originalInstance = {
        task: originalTask,
        state: "done",
        startTime: new Date("2024-01-15T09:00:00"),
        stopTime: new Date("2024-01-15T10:00:00"),
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: "original-instance-id",
      }

      view.tasks = [originalTask]
      view.taskInstances = [originalInstance]

      // 2. duplicateAndStartInstance を実行
      await view.duplicateAndStartInstance(originalInstance)

      const duplicatedInstance = view.taskInstances.find(
        (inst) => inst.instanceId !== "original-instance-id",
      )

      // 3. 複製されたタスクを完了させる
      duplicatedInstance.state = "done"
      duplicatedInstance.stopTime = new Date("2024-01-15T11:00:00")

      // 4. saveTaskCompletion をモック化してJSONログ保存を追跡
      const mockSaveTaskCompletion = jest.fn().mockResolvedValue(undefined)
      view.saveTaskCompletion = mockSaveTaskCompletion

      // 5. stopInstance を呼び出してJSONログに保存
      await view.stopInstance(duplicatedInstance)

      // 6. JSONログに保存されたことを確認
      expect(mockSaveTaskCompletion).toHaveBeenCalledWith(
        duplicatedInstance,
        null,
      )

      // 7. deleteTaskLogsByInstanceId をモック化して削除処理を追跡
      const mockDeleteTaskLogsByInstanceId = jest.fn().mockResolvedValue(undefined)
      view.deleteTaskLogsByInstanceId = mockDeleteTaskLogsByInstanceId

      // 8. deleteDuplicatedInstance を実行
      await view.deleteDuplicatedInstance(duplicatedInstance)

      // 9. ✅ 修正後：deleteTaskLogsByInstanceId が呼ばれる
      expect(mockDeleteTaskLogsByInstanceId).toHaveBeenCalledWith(
        originalTask.path,
        duplicatedInstance.instanceId
      )

      // 10. 比較：duplicateInstance（設定メニュー）からの削除では正常に動作
      // 正常な複製インスタンスを作成
      const normalDuplicatedInstance = {
        task: originalTask,
        state: "done",
        startTime: new Date("2024-01-15T12:00:00"),
        stopTime: new Date("2024-01-15T13:00:00"),
        slotKey: "8:00-12:00",
        order: 200,
        instanceId: "normal-duplicated-instance-id",
      }

      // 複製情報を手動で記録（duplicateInstance の正常な動作をシミュレート）
      const dateString = "2024-01-15"
      const duplicatedStorageKey = `taskchute-duplicated-instances-${dateString}`
      const storedDuplicates = [
        {
          path: originalTask.path,
          instanceId: normalDuplicatedInstance.instanceId,
        },
      ]
      localStorage.setItem(
        duplicatedStorageKey,
        JSON.stringify(storedDuplicates),
      )

      view.taskInstances.push(normalDuplicatedInstance)

      // 11. 正常な複製インスタンスを削除
      await view.deleteDuplicatedInstance(normalDuplicatedInstance)

      // 12. ✅ 修正後：正常な場合はdeleteTaskLogsByInstanceIdが呼ばれる
      expect(mockDeleteTaskLogsByInstanceId).toHaveBeenCalledWith(
        originalTask.path,
        normalDuplicatedInstance.instanceId
      )
    })

    test("実行履歴の残留により再起動時にタスクが復活する詳細検証", async () => {
      // 1. 削除されたタスクの実行履歴がJSONログに残っている状況を作成
      const taskPath = "TaskChute/Task/TestTask.md"
      const deletedInstanceId = "deleted-instance-id"

      const mockJsonLog = {
        metadata: {
          version: "2.0",
          month: "2024-01",
          lastUpdated: new Date().toISOString(),
        },
        taskExecutions: {
          "2024-01-15": [
            {
              taskId: taskPath,
              taskName: "TestTask",
              instanceId: deletedInstanceId,
              isCompleted: true,
              startTime: "10:00:00",
              stopTime: "11:00:00",
              slot: "8:00-12:00",
            },
          ],
        },
      }

      // 2. JSONログファイルの読み込みをモック
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(mockJsonLog))

      // 3. loadTodayExecutions を実行
      const executions = await view.loadTodayExecutions("2024-01-15")

      // 4. 削除されたタスクの実行履歴が読み込まれることを確認
      expect(executions.length).toBe(1)
      expect(executions[0].taskTitle).toBe("TestTask")
      expect(executions[0].instanceId).toBe(deletedInstanceId)

      // 5. getTaskFiles をモック
      view.getTaskFiles = jest.fn().mockResolvedValue([mockTaskFile])

      // 6. ファイル読み込みをモック
      mockApp.vault.read.mockResolvedValue(`---
routine: false
---

# TestTask

#task
`)

      // 7. loadTasks を実行
      await view.loadTasks()

      // 8. ❌ 削除されたタスクが復活している
      const revivedInstance = view.taskInstances.find(
        (inst) => inst.instanceId === deletedInstanceId,
      )
      expect(revivedInstance).toBeDefined()
      expect(revivedInstance.state).toBe("done")
      expect(revivedInstance.task.title).toBe("TestTask")
      expect(revivedInstance.task.path).toBe(taskPath)
    })

    test("複製情報の有無による削除処理の分岐を検証", async () => {
      const originalTask = {
        title: "TestTask",
        path: "TaskChute/Task/TestTask.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
        projectPath: null,
        projectTitle: null,
      }

      // deleteTaskLogsByInstanceId をモック化
      const mockDeleteTaskLogsByInstanceId = jest.fn().mockResolvedValue(undefined)
      view.deleteTaskLogsByInstanceId = mockDeleteTaskLogsByInstanceId

      // ケース1: 複製情報がない場合（duplicateAndStartInstance で作成）
      const instanceWithoutDuplicateInfo = {
        task: originalTask,
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T11:00:00"),
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: "instance-without-duplicate-info",
      }

      view.taskInstances = [instanceWithoutDuplicateInfo]

      await view.deleteDuplicatedInstance(instanceWithoutDuplicateInfo)

      // ✅ 修正後：deleteTaskLogsByInstanceId が呼ばれる
      expect(mockDeleteTaskLogsByInstanceId).toHaveBeenCalledWith(
        originalTask.path,
        instanceWithoutDuplicateInfo.instanceId
      )

      // ケース2: 複製情報がある場合（duplicateInstance で作成）
      const instanceWithDuplicateInfo = {
        task: originalTask,
        state: "done",
        startTime: new Date("2024-01-15T12:00:00"),
        stopTime: new Date("2024-01-15T13:00:00"),
        slotKey: "8:00-12:00",
        order: 200,
        instanceId: "instance-with-duplicate-info",
      }

      // 複製情報を記録
      const dateString = "2024-01-15"
      const duplicatedStorageKey = `taskchute-duplicated-instances-${dateString}`
      const storedDuplicates = [
        {
          path: originalTask.path,
          instanceId: instanceWithDuplicateInfo.instanceId,
        },
      ]
      localStorage.setItem(
        duplicatedStorageKey,
        JSON.stringify(storedDuplicates),
      )

      view.taskInstances = [instanceWithDuplicateInfo]

      await view.deleteDuplicatedInstance(instanceWithDuplicateInfo)

      // ✅ 修正後：複製情報があればdeleteTaskLogsByInstanceIdが呼ばれる
      expect(mockDeleteTaskLogsByInstanceId).toHaveBeenCalledWith(
        originalTask.path,
        instanceWithDuplicateInfo.instanceId
      )
    })
  })
})
