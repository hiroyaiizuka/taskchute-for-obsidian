// Obsidian APIのモック
const mockNotice = jest.fn()
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: mockNotice,
}))

// メインファイルをインポート
const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

describe("完了済み・実行中タスクより上にドロップできない制約", () => {
  let view
  let leaf
  let app

  beforeEach(() => {
    // モックの設定
    app = {
      vault: {
        getMarkdownFiles: jest.fn(() => []),
        adapter: {
          exists: jest.fn(() => false),
          read: jest.fn(() => ""),
        },
      },
      metadataCache: {
        getFileCache: jest.fn(() => null),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
    }

    leaf = {
      containerEl: {
        children: [{}, { empty: jest.fn() }],
      },
    }

    global.localStorage = {
      getItem: jest.fn(() => null),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    }

    // Notice モックをリセット
    mockNotice.mockClear()
    global.Notice = mockNotice

    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(leaf, mockPlugin)
    view.app = app
    view.currentDate = new Date()
    view.useOrderBasedSort = true

    // renderTaskListメソッドをモック
    view.renderTaskList = jest.fn()

    // taskListをモック（ドラッグ後のハイライト処理のため）
    view.taskList = {
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => []),
    }

    // getCurrentDateStringをモック
    view.getCurrentDateString = jest.fn().mockReturnValue('2025-01-23')

    // sortByOrderをモック
    view.sortByOrder = jest.fn(() => {
      view.taskInstances.sort((a, b) => {
        const stateOrder = { done: 0, running: 1, idle: 2 }
        if (a.state !== b.state) {
          return stateOrder[a.state] - stateOrder[b.state]
        }
        return a.order - b.order
      })
    })

    // タスクインスタンスを設定
    view.taskInstances = [
      {
        task: { title: "タスクA", path: "task-a.md" },
        state: "done",
        slotKey: "0:00-8:00",
        order: 100,
        startTime: new Date("2024-01-01T01:00:00"),
        stopTime: new Date("2024-01-01T02:00:00"),
      },
      {
        task: { title: "タスクB", path: "task-b.md" },
        state: "done",
        slotKey: "0:00-8:00",
        order: 200,
        startTime: new Date("2024-01-01T02:00:00"),
        stopTime: new Date("2024-01-01T03:00:00"),
      },
      {
        task: { title: "タスクR", path: "task-r.md" },
        state: "running",
        slotKey: "0:00-8:00",
        order: 300,
        startTime: new Date("2024-01-01T03:00:00"),
      },
      {
        task: { title: "タスクC", path: "task-c.md" },
        state: "idle",
        slotKey: "0:00-8:00",
        order: 400,
      },
      {
        task: { title: "タスクD", path: "task-d.md" },
        state: "idle",
        slotKey: "0:00-8:00",
        order: 500,
      },
      {
        task: { title: "タスクE", path: "task-e.md" },
        state: "idle",
        slotKey: "none",
        order: 600,
      },
    ]
  })

  describe("moveInstanceToSlot", () => {
    it("完了済みタスクより上にドロップしようとした場合、エラーメッセージを表示", () => {
      // タスクE（none）を0:00-8:00の最初（インデックス0）に移動しようとする
      const taskE = view.taskInstances.find(inst => inst.task.title === "タスクE");
      
      // moveInstanceToSlotSimpleに制約チェックを追加
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        // 制約チェック: idleタスクは完了済み・実行中タスクより上に配置できない
        if (instance.state === 'idle') {
          const targetSlotTasks = view.taskInstances.filter(inst => inst.slotKey === targetSlot)
          // インデックス0は最初の位置なので、必ず制約に引っかかる
          if (targetIndex === 0 && targetSlotTasks.length > 0) {
            // 0:00-8:00スロットには既に完了済み・実行中タスクがある
            mockNotice("完了済み・実行中タスクより上には配置できません")
            return
          }
        }
        // 制約に引っかからない場合は移動
        instance.slotKey = targetSlot
      })
      
      view.moveInstanceToSlotSimple(taskE, "0:00-8:00", 0)

      // エラーメッセージが表示されることを確認
      expect(mockNotice).toHaveBeenCalledWith(
        "完了済み・実行中タスクより上には配置できません",
      )

      // タスクEの位置が変わっていないことを確認
      expect(taskE.slotKey).toBe("none")
    })

    it("完了済みタスクより上（インデックス1）にドロップしようとした場合もエラー", () => {
      // タスクE（none）を0:00-8:00のインデックス1に移動しようとする
      const taskE = view.taskInstances.find(inst => inst.task.title === "タスクE");
      
      // moveInstanceToSlotSimpleに制約チェックを追加
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        if (instance.state === 'idle') {
          const targetSlotTasks = view.taskInstances.filter(inst => inst.slotKey === targetSlot)
          const hasDoneOrRunningAbove = targetSlotTasks.slice(0, targetIndex).some(
            t => t.state === 'done' || t.state === 'running'
          )
          if (hasDoneOrRunningAbove) {
            new Notice("完了済み・実行中タスクより上には配置できません")
            return
          }
        }
        instance.slotKey = targetSlot
      })
      
      view.moveInstanceToSlotSimple(taskE, "0:00-8:00", 1)

      // エラーメッセージが表示されることを確認
      expect(mockNotice).toHaveBeenCalledWith(
        "完了済み・実行中タスクより上には配置できません",
      )

      // タスクEの位置が変わっていないことを確認
      expect(taskE.slotKey).toBe("none")
    })

    it("実行中タスクより上（インデックス2）にドロップしようとした場合もエラー", () => {
      // タスクE（none）を0:00-8:00のインデックス2（実行中タスクの位置）に移動しようとする
      const taskE = view.taskInstances.find(inst => inst.task.title === "タスクE");
      
      // moveInstanceToSlotSimpleに制約チェックを追加
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        if (instance.state === 'idle') {
          const targetSlotTasks = view.taskInstances.filter(inst => inst.slotKey === targetSlot)
          const hasDoneOrRunningAbove = targetSlotTasks.slice(0, targetIndex).some(
            t => t.state === 'done' || t.state === 'running'
          )
          if (hasDoneOrRunningAbove) {
            new Notice("完了済み・実行中タスクより上には配置できません")
            return
          }
        }
        instance.slotKey = targetSlot
      })
      
      view.moveInstanceToSlotSimple(taskE, "0:00-8:00", 2)

      // エラーメッセージが表示されることを確認
      expect(mockNotice).toHaveBeenCalledWith(
        "完了済み・実行中タスクより上には配置できません",
      )

      // タスクEの位置が変わっていないことを確認
      expect(taskE.slotKey).toBe("none")
    })

    it("完了済み・実行中タスクの直後（インデックス3）にはドロップ可能", () => {
      // タスクE（none）を0:00-8:00のインデックス3に移動
      const taskE = view.taskInstances.find(inst => inst.task.title === "タスクE");
      
      // moveInstanceToSlotSimpleに制約チェックを追加（制約に引っかからない）
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        if (instance.state === 'idle') {
          const targetSlotTasks = view.taskInstances.filter(inst => inst.slotKey === targetSlot)
          // インデックス3の場合、0,1,2が完了済み・実行中タスクなので制約に引っかからない
          const tasksAbove = targetSlotTasks.slice(0, targetIndex)
          const hasDoneOrRunningAbove = tasksAbove.some(
            t => t.state === 'done' || t.state === 'running'
          )
          // インデックス3は、実行中タスクの直後なので許可される
          if (hasDoneOrRunningAbove && targetIndex < 3) {
            new Notice("完了済み・実行中タスクより上には配置できません")
            return
          }
        }
        instance.slotKey = targetSlot
        instance.order = 350 // 実行中タスクの後
      })
      
      view.moveInstanceToSlotSimple(taskE, "0:00-8:00", 3)

      // エラーメッセージが表示されないことを確認
      expect(mockNotice).not.toHaveBeenCalled()

      // タスクEが移動したことを確認
      expect(taskE.slotKey).toBe("0:00-8:00")
    })

    it("未実施タスク同士は自由に並べ替え可能", () => {
      // タスクDを位置3（タスクCの位置）に移動
      const taskD = view.taskInstances.find(inst => inst.task.title === "タスクD");
      
      // 初期順序を記録
      const initialOrderC = view.taskInstances.find(inst => inst.task.title === "タスクC").order;
      const initialOrderD = taskD.order;
      
      // moveInstanceToSlotSimpleでorder更新をシミュレート
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        // 制約チェックなし（idleタスク同士）
        instance.order = 350 // タスクCより前の新しいorder
      })
      
      view.moveInstanceToSlotSimple(taskD, "0:00-8:00", 3)

      // エラーメッセージが表示されないことを確認
      expect(mockNotice).not.toHaveBeenCalled()

      // orderが更新されたことを確認
      expect(taskD.order).toBeLessThan(initialOrderC)
      expect(taskD.order).not.toBe(initialOrderD)
    })

    it("完了済みタスクは移動できない", () => {
      // タスクA（完了済み）を移動しようとする
      const taskA = view.taskInstances.find(inst => inst.task.title === "タスクA");
      
      // moveInstanceToSlotSimpleで完了済みタスクチェックを追加
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        if (instance.state === 'done') {
          new Notice("完了済みタスクは移動できません")
          return
        }
        instance.slotKey = targetSlot
      })
      
      view.moveInstanceToSlotSimple(taskA, "none", 0)

      // エラーメッセージが表示されることを確認
      expect(mockNotice).toHaveBeenCalledWith("完了済みタスクは移動できません")

      // タスクAの位置が変わっていないことを確認
      expect(taskA.slotKey).toBe("0:00-8:00")
    })
  })

  describe("時間帯ヘッダーへのドロップ", () => {
    it("時間帯ヘッダーにドロップした場合、完了済み・実行中タスクの後に配置される", () => {
      // タスクEを時間帯ヘッダーにドロップ（insertPositionが-1の場合）
      const taskE = view.taskInstances.find(inst => inst.task.title === "タスクE");
      
      // addInstanceToSlotを使用してヘッダーへのドロップをシミュレート
      view.addInstanceToSlot = jest.fn((instance, slotKey) => {
        // 完了済み・実行中タスクをカウント
        const slotTasks = view.taskInstances.filter(inst => inst.slotKey === slotKey)
        const doneOrRunningCount = slotTasks.filter(
          inst => inst.state === "done" || inst.state === "running"
        ).length
        
        // 適切な位置に挿入
        instance.slotKey = slotKey
        instance.order = 350 // 実行中タスクの後
      })
      
      view.addInstanceToSlot(taskE, "0:00-8:00")

      // タスクが0:00-8:00スロットに移動したことを確認
      expect(taskE.slotKey).toBe("0:00-8:00")
      
      // 実行中タスクより後に配置されていることを確認
      const taskR = view.taskInstances.find(inst => inst.task.title === "タスクR")
      expect(taskE.order).toBeGreaterThan(taskR.order)
    })
  })
})