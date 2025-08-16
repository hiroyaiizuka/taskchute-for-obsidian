const { TaskChuteView } = require("../main")
const { Notice } = require("obsidian")

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

describe("非表示リストのエッジケース", () => {
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
      },
    }

    view = new TaskChuteView(mockLeaf, plugin)
    view.app = mockApp
    view.plugin = plugin
    view.currentDate = new Date("2025-08-01T09:00:00+09:00")
    view.taskInstances = []
    view.renderTaskList = jest.fn()
    view.saveRunningTasksState = jest.fn().mockResolvedValue(undefined)
    view.saveHiddenRoutines = jest.fn()

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

  describe("複製されたタスクの処理", () => {
    test("複製されたタスクの削除は元のタスクに影響しない", async () => {
      const taskPath = "routine-task.md"
      const inst1 = {
        task: { title: "ルーチンタスク", path: taskPath, isRoutine: true },
        state: "idle",
        instanceId: "instance-1",
      }
      const inst2 = {
        task: { title: "ルーチンタスク", path: taskPath, isRoutine: true },
        state: "idle",
        instanceId: "instance-2",
      }

      // 複製情報を設定
      global.localStorage.setItem(
        "taskchute-duplicated-instances-2025-08-01",
        JSON.stringify([{ path: taskPath, instanceId: "instance-2" }]),
      )

      view.taskInstances = [inst1, inst2]

      // inst2（複製）を削除
      await view.deleteRoutineTask(inst2)

      // inst1は残っているべき
      expect(view.taskInstances).toHaveLength(1)
      expect(view.taskInstances[0]).toBe(inst1)

      // saveHiddenRoutinesが呼ばれたことを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalled()
      const savedRoutines = view.saveHiddenRoutines.mock.calls[0][1]
      const hiddenInst2 = savedRoutines.find(
        (r) => r.instanceId === "instance-2",
      )
      expect(hiddenInst2).toBeDefined()
      expect(hiddenInst2.instanceId).toBe("instance-2")
    })
  })

  describe("日付変更時の動作", () => {
    test("別の日付では非表示リストの影響を受けない", () => {
      const taskPath = "daily-task.md"

      // 8月1日の非表示リスト
      global.localStorage.setItem(
        "taskchute-hidden-routines-2025-08-01",
        JSON.stringify([{ path: taskPath, instanceId: null }]),
      )

      // 8月1日では非表示
      const aug1Hidden = view.getHiddenRoutines("2025-08-01")
      expect(aug1Hidden).toHaveLength(1)

      // 8月2日では非表示ではない
      const aug2Hidden = view.getHiddenRoutines("2025-08-02")
      expect(aug2Hidden).toHaveLength(0)
    })
  })

  describe("削除保護の動作確認", () => {
    test("実行中タスクの削除時も適切に処理される", async () => {
      const inst = {
        task: { title: "テストタスク", path: "test.md", isRoutine: true },
        state: "running", // 実行中
        instanceId: "test-instance",
      }

      view.taskInstances = [inst]
      view.saveRunningTasksState = jest.fn()

      await view.deleteRoutineTask(inst)

      // 実行中タスクの状態が保存される
      expect(view.saveRunningTasksState).toHaveBeenCalled()
      expect(view.taskInstances).toHaveLength(0)
    })

    test("すべてのタスク状態で削除が可能（制限撤廃後）", async () => {
      const states = ["done", "idle", "running"]

      for (const state of states) {
        const inst = {
          task: { title: `${state}タスク`, path: "test.md", isRoutine: true },
          state: state,
          instanceId: `${state}-instance`,
        }

        view.taskInstances = [inst]
        Notice.mockClear()

        await view.deleteRoutineTask(inst)

        // すべての状態で削除が実行される（制限撤廃後）
        expect(view.taskInstances).toHaveLength(0)

        // 適切な通知メッセージが表示される
        expect(Notice).toHaveBeenCalledWith(
          `「${state}タスク」を本日のリストから削除しました。\n（他の日付には影響しません）`,
        )
      }
    })
  })
})
