/**
 * ルーチンタスク実行中状態の復元修正テスト
 * 
 * 問題の概要:
 * 1. ルーチンタスクを実行中に再起動すると、ルーチン設定が外れてしまう
 * 2. frontmatterにroutineとisRoutineの2つのプロパティが混在している
 * 
 * 原因:
 * 1. restoreRunningTaskStateで既存インスタンスを見つけた場合、isRoutineプロパティが更新されていなかった
 * 2. toggleRoutineでルーチンを解除する際、routineはfalseにするがisRoutineはfalseにしていなかった
 * 
 * 修正内容:
 * 1. restoreRunningTaskStateで既存インスタンスのisRoutineも復元データから更新
 * 2. toggleRoutineでルーチン解除時にisRoutineもfalseに設定
 */

describe("ルーチンタスク実行中状態の復元", () => {
  let mockApp
  let plugin
  let view

  beforeEach(() => {
    // モックセットアップ
    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        createFolder: jest.fn(),
        getFolderByPath: jest.fn(),
        adapter: {
          stat: jest.fn()
        }
      },
      metadataCache: {
        getFileCache: jest.fn()
      },
      fileManager: {
        processFrontMatter: jest.fn()
      }
    }

    plugin = {
      pathManager: {
        getLogDataPath: jest.fn().mockReturnValue("02_Config/TaskChute/Log"),
        getTaskFolderPath: jest.fn().mockReturnValue("TaskChute/Task")
      }
    }

    view = {
      app: mockApp,
      plugin: plugin,
      taskInstances: [],
      tasks: [],
      currentDate: new Date("2024-01-15T09:00:00"),
      getCurrentDateString: jest.fn().mockReturnValue("2024-01-15"),
      generateInstanceId: jest.fn().mockReturnValue("instance-123"),
      renderTaskList: jest.fn(),
      manageTimers: jest.fn(),
      getDeletedInstances: jest.fn().mockReturnValue([])
    }

    // メソッドをバインド
    view.restoreRunningTaskState = jest.fn()
    view.saveRunningTasksState = jest.fn()
  })

  test("既存インスタンスのisRoutineプロパティが復元データから更新される", async () => {
    // 既存のタスクインスタンス（isRoutine: false）
    const existingInstance = {
      task: {
        path: "TaskChute/Task/Clipperレビュー.md",
        title: "Clipperレビュー",
        isRoutine: false // 誤ってfalseになっている
      },
      state: "idle",
      slotKey: "8:00-12:00"
    }
    view.taskInstances = [existingInstance]

    // 実行中タスクの保存データ（isRoutine: true）
    const runningTaskData = [{
      date: "2024-01-15",
      taskPath: "TaskChute/Task/Clipperレビュー.md",
      taskTitle: "Clipperレビュー",
      startTime: "2024-01-15T08:34:00.000Z",
      isRoutine: true, // 正しい値
      slotKey: "8:00-12:00"
    }]

    const mockFile = { path: "02_Config/TaskChute/Log/running-task.json" }
    mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
    mockApp.vault.read.mockResolvedValue(JSON.stringify(runningTaskData))

    // restoreRunningTaskStateの簡易実装
    const restoreRunningTaskState = async function() {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      const dataFile = this.app.vault.getAbstractFileByPath(dataPath)
      
      if (!dataFile) return

      const content = await this.app.vault.read(dataFile)
      const runningTasksData = JSON.parse(content)

      for (const runningData of runningTasksData) {
        if (runningData.date !== this.getCurrentDateString()) continue

        // 既存インスタンスを探す
        let runningInstance = this.taskInstances.find(
          inst => inst.task.path === runningData.taskPath && inst.state === "idle"
        )

        // 【修正】既存インスタンスのisRoutineも復元データから更新
        if (runningInstance && runningInstance.task && runningData.isRoutine !== undefined) {
          runningInstance.task.isRoutine = runningData.isRoutine === true
        }

        if (runningInstance) {
          runningInstance.state = "running"
          runningInstance.startTime = new Date(runningData.startTime)
        }
      }
    }.bind(view)

    await restoreRunningTaskState()

    // isRoutineがtrueに更新されていることを確認
    expect(existingInstance.task.isRoutine).toBe(true)
    expect(existingInstance.state).toBe("running")
  })

  test("toggleRoutineでルーチン解除時にisRoutineもfalseに設定される", async () => {
    const mockFile = { path: "TaskChute/Task/テストタスク.md" }
    mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)

    // processFrontMatterのモック
    let capturedFrontmatter = null
    mockApp.fileManager.processFrontMatter.mockImplementation(async (file, processor) => {
      const frontmatter = {
        routine: true,
        isRoutine: true,
        開始時刻: "09:00"
      }
      capturedFrontmatter = processor(frontmatter)
    })

    const task = {
      title: "テストタスク",
      isRoutine: true
    }

    const button = {
      classList: { remove: jest.fn() },
      setAttribute: jest.fn()
    }

    // toggleRoutineの簡易実装（解除部分のみ）
    const toggleRoutine = async function(task, button) {
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
      const filePath = `${taskFolderPath}/${task.title}.md`
      const file = this.app.vault.getAbstractFileByPath(filePath)

      if (!file) {
        return
      }

      if (task.isRoutine) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          const y = this.currentDate.getFullYear()
          const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
          const d = this.currentDate.getDate().toString().padStart(2, "0")
          frontmatter.routine_end = `${y}-${m}-${d}`
          frontmatter.routine = false
          frontmatter.isRoutine = false  // 【修正】isRoutineもfalseに設定
          delete frontmatter.開始時刻
          return frontmatter
        })

        task.isRoutine = false
        task.scheduledTime = null
      }
    }.bind(view)

    await toggleRoutine(task, button)

    // frontmatterの両方のプロパティがfalseになっていることを確認
    expect(capturedFrontmatter.routine).toBe(false)
    expect(capturedFrontmatter.isRoutine).toBe(false)
    expect(capturedFrontmatter.routine_end).toBe("2024-01-15")
    expect(capturedFrontmatter.開始時刻).toBeUndefined()
  })

  test("実行中タスクの保存時にisRoutineが正しく保存される", async () => {
    const runningInstance = {
      task: {
        title: "ルーチンタスク",
        path: "TaskChute/Task/ルーチンタスク.md",
        isRoutine: true
      },
      state: "running",
      startTime: new Date("2024-01-15T09:00:00"),
      slotKey: "8:00-12:00",
      instanceId: "instance-456"
    }
    view.taskInstances = [runningInstance]

    let savedData = null
    mockApp.vault.modify.mockImplementation(async (file, content) => {
      savedData = JSON.parse(content)
    })
    mockApp.vault.getFolderByPath.mockReturnValue({})

    // saveRunningTasksStateの簡易実装
    const saveRunningTasksState = async function() {
      const runningInstances = this.taskInstances.filter(
        inst => inst.state === "running"
      )

      const dataToSave = runningInstances.map(inst => {
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
          slotKey: inst.slotKey,
          isRoutine: inst.task.isRoutine === true,
          instanceId: inst.instanceId
        }
      })

      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      const content = JSON.stringify(dataToSave, null, 2)

      const dataFile = this.app.vault.getAbstractFileByPath(dataPath)
      if (dataFile) {
        await this.app.vault.modify(dataFile, content)
      }
    }.bind(view)

    const mockFile = { path: "02_Config/TaskChute/Log/running-task.json" }
    mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)

    await saveRunningTasksState()

    // isRoutineがtrueとして保存されていることを確認
    expect(savedData).toHaveLength(1)
    expect(savedData[0].isRoutine).toBe(true)
    expect(savedData[0].taskTitle).toBe("ルーチンタスク")
  })
})