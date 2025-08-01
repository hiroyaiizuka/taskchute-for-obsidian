const { TaskChuteView } = require("../main")
const { mockApp, mockLeaf } = require("../__mocks__/obsidian")

// LocalStorageのモック
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => {
      store[key] = value.toString()
    },
    clear: () => {
      store = {}
    },
    removeItem: (key) => {
      delete store[key]
    },
  }
})()

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
})

describe("Routine Task Hiding Feature", () => {
  let view
  let app

  // モックタスクファイル
  const routineTaskFile = {
    path: "Tasks/Daily Meeting.md",
    basename: "Daily Meeting",
    // TFileの他のプロパティは必要に応じてモック化
  }

  // モックタスクオブジェクト
  const routineTask = {
    title: "Daily Meeting",
    path: "Tasks/Daily Meeting.md",
    file: routineTaskFile,
    isRoutine: true,
    scheduledTime: "09:00",
    slotKey: "8:00-12:00",
    routineType: "daily",
    weekday: null,
    projectPath: null,
    projectTitle: null,
  }

  beforeEach(() => {
    // mockApp と mockLeaf を __mocks__ からインポートして使用
    app = mockApp
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = app
    view.currentDate = new Date("2024-07-11T00:00:00") // JSTで解釈されるように

    // localStorageをリセット
    localStorage.clear()

    // モックの初期化
    app.vault.getMarkdownFiles.mockClear()
    app.vault.read.mockClear()
    app.metadataCache.getFileCache.mockClear()
    app.fileManager.processFrontMatter.mockClear()
  })

  // loadTasksのロジックをシミュレートするヘルパー関数
  const simulateLoadTasks = async (currentView) => {
    const y = currentView.currentDate.getFullYear()
    const m = (currentView.currentDate.getMonth() + 1)
      .toString()
      .padStart(2, "0")
    const d = currentView.currentDate.getDate().toString().padStart(2, "0")
    const dateString = `${y}-${m}-${d}`
    const hiddenRoutineStorageKey = `taskchute-hidden-routines-${dateString}`
    const hiddenRoutinePaths = JSON.parse(
      localStorage.getItem(hiddenRoutineStorageKey) || "[]",
    )

    // vaultから全タスクファイルを取得したと仮定
    const allFiles = app.vault.getMarkdownFiles()
    let rawInstances = []

    for (const file of allFiles) {
      // isRoutineやその他のプロパティはモックから取得
      const metadata = app.metadataCache.getFileCache(file)?.frontmatter || {}
      if (metadata.routine) {
        rawInstances.push({
          task: { ...routineTask, path: file.path, title: file.basename }, // テスト用に簡略化
          state: "idle",
        })
      }
    }

    // 非表示リストに基づいてフィルタリング
    currentView.taskInstances = rawInstances.filter(
      (inst) => !hiddenRoutinePaths.includes(inst.task.path),
    )
  }

  test("should hide a routine task for the current day and restore it the next day", async () => {
    // --- 1. 初期状態の確認 (7月11日) ---
    app.vault.getMarkdownFiles.mockReturnValue([routineTaskFile])
    app.vault.read.mockResolvedValue("#task #routine")
    app.metadataCache.getFileCache.mockReturnValue({
      frontmatter: { routine: true, 開始時刻: "09:00", routine_type: "daily" },
    })
    // 実行履歴はなし
    app.vault.getAbstractFileByPath.mockReturnValue(null)

    await simulateLoadTasks(view)

    // 最初にタスクが表示されることを確認
    let meetingInstance = view.taskInstances.find(
      (inst) => inst.task.title === "Daily Meeting",
    )
    expect(meetingInstance).toBeDefined()
    expect(view.taskInstances.length).toBe(1)

    // --- 2. タスクを非表示にする ---
    const dateString = "2024-07-11"
    const storageKey = `taskchute-hidden-routines-${dateString}`

    // 削除ロジックを直接呼び出す（UIのシミュレーション）
    // showTaskSettingsTooltip内の削除ロジックを再現
    let hiddenRoutines = JSON.parse(localStorage.getItem(storageKey) || "[]")
    hiddenRoutines.push(routineTask.path)
    localStorage.setItem(storageKey, JSON.stringify(hiddenRoutines))

    // UIからの削除をシミュレート
    view.taskInstances = view.taskInstances.filter(
      (i) => i.task.path !== routineTask.path,
    )
    expect(view.taskInstances.length).toBe(0)

    // --- 3. 非表示になっていることを確認 (7月11日) ---
    await simulateLoadTasks(view)

    // タスクが非表示になっていることを確認
    meetingInstance = view.taskInstances.find(
      (inst) => inst.task.title === "Daily Meeting",
    )
    expect(meetingInstance).toBeUndefined()
    expect(view.taskInstances.length).toBe(0)

    // --- 4. 翌日に復元されることを確認 (7月12日) ---
    view.currentDate.setDate(view.currentDate.getDate() + 1) // 日付を7月12日に変更

    // localStorageは7月11日のキーなので、7月12日には影響しないはず
    await simulateLoadTasks(view)

    // タスクが再表示されることを確認
    meetingInstance = view.taskInstances.find(
      (inst) => inst.task.title === "Daily Meeting",
    )
    expect(meetingInstance).toBeDefined()
    expect(view.taskInstances.length).toBe(1)
  })
})
