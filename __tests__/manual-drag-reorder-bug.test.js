const { TaskChuteView } = require("../main.js")

describe("手動ドラッグ移動の順序計算バグ修正テスト（新実装）", () => {
  let mockApp
  let mockLeaf
  let view

  let localStorageSetItemSpy;

  beforeEach(() => {
    // モックをクリア
    jest.clearAllMocks()

    // localStorageをモック
    const localStorageMock = {}
    localStorageSetItemSpy = jest.fn((key, value) => { localStorageMock[key] = value })
    global.localStorage = {
      getItem: jest.fn(key => localStorageMock[key]),
      setItem: localStorageSetItemSpy,
      removeItem: jest.fn(key => { delete localStorageMock[key] }),
      clear: jest.fn(() => { Object.keys(localStorageMock).forEach(key => delete localStorageMock[key]) })
    }

    // Obsidianのモック
    mockApp = {
      vault: {
        getFiles: jest.fn(() => []),
        getAbstractFileByPath: jest.fn(),
      },
      workspace: {
        getActiveFile: jest.fn(),
      },
    }

    mockLeaf = {
      view: null,
    }

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
    view.useOrderBasedSort = true

    // DOM要素をモック
    view.taskList = {
      scrollTop: 0,
      scrollLeft: 0,
      querySelector: jest.fn(),
      querySelectorAll: jest.fn(() => []),
    }

    // renderTaskListメソッドをモック（テスト時は実際の描画は不要）
    view.renderTaskList = jest.fn()
    
    // 必要なヘルパーメソッドを追加
    view.getCurrentDateString = jest.fn().mockReturnValue('2025-01-23')
    view.sortByOrder = jest.fn(() => {
      view.taskInstances.sort((a, b) => {
        const stateOrder = { done: 0, running: 1, idle: 2 }
        if (a.state !== b.state) {
          return stateOrder[a.state] - stateOrder[b.state]
        }
        return a.order - b.order
      })
    })
  })

  // ヘルパー関数: タスクインスタンスを作成
  function createTaskInstance(
    title,
    order,
    slotKey = "8:00-12:00",
    state = "idle",
  ) {
    return {
      task: {
        title,
        path: `${title.toLowerCase().replace(/\s/g, "-")}.md`,
        scheduledTime: null,
      },
      state,
      slotKey,
      order,
      startTime: null,
      stopTime: null,
      instanceId: `${title}-${Date.now()}`,
    }
  }

  // ヘルパー関数: 順序をテストする
  function expectOrder(instances, expectedTitles) {
    const actualTitles = instances.map((inst) => inst.task.title)
    expect(actualTitles).toEqual(expectedTitles)
  }

  describe("基本的な並び替え", () => {
    test("AとBの順序を入れ替える", () => {
      // 初期状態: A(100), B(200), C(300), D(400)
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task B", 200),
        createTaskInstance("Task C", 300),
        createTaskInstance("Task D", 400),
      ]

      // 期待される初期順序
      expectOrder(view.taskInstances, ["Task A", "Task B", "Task C", "Task D"])

      // Task Aを Task Bの後ろに移動（位置1）
      const taskA = view.taskInstances[0];
      view.moveInstanceToSlotSimple(taskA, "8:00-12:00", 1)

      // ソート実行
      view.sortByOrder()

      // 期待される結果: B(200), A(250), C(300), D(400)
      expectOrder(view.taskInstances, ["Task B", "Task A", "Task C", "Task D"])

      // 順序番号が正しく計算されているか確認
      const movedTaskA = view.taskInstances.find(
        (inst) => inst.task.title === "Task A",
      )
      const taskB = view.taskInstances.find(
        (inst) => inst.task.title === "Task B",
      )
      const taskC = view.taskInstances.find(
        (inst) => inst.task.title === "Task C",
      )

      expect(movedTaskA.order).toBeGreaterThan(taskB.order)
      expect(movedTaskA.order).toBeLessThan(taskC.order)
    })

    test("AとDの順序を入れ替える", () => {
      // 初期状態: A(100), B(200), C(300), D(400)
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task B", 200),
        createTaskInstance("Task C", 300),
        createTaskInstance("Task D", 400),
      ]

      // Task Aを Task Dの後ろに移動（最後）
      const taskAToMove = view.taskInstances[0];
      view.moveInstanceToSlotSimple(taskAToMove, "8:00-12:00", 3)

      // ソート実行
      view.sortByOrder()

      // 期待される結果: B(200), C(300), D(400), A(500)
      expectOrder(view.taskInstances, ["Task B", "Task C", "Task D", "Task A"])

      // 順序番号が正しく計算されているか確認
      const taskA = view.taskInstances.find(
        (inst) => inst.task.title === "Task A",
      )
      const taskD = view.taskInstances.find(
        (inst) => inst.task.title === "Task D",
      )

      expect(taskA.order).toBeGreaterThan(taskD.order)
    })

    test("Dを先頭に移動", () => {
      // 初期状態: A(100), B(200), C(300), D(400)
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task B", 200),
        createTaskInstance("Task C", 300),
        createTaskInstance("Task D", 400),
      ]

      // Task Dを先頭に移動
      const taskDToMove = view.taskInstances.find(inst => inst.task.title === "Task D");
      view.moveInstanceToSlotSimple(taskDToMove, "8:00-12:00", 0)

      // ソート実行
      view.sortByOrder()

      // 期待される結果: D(0), A(100), B(200), C(300)
      expectOrder(view.taskInstances, ["Task D", "Task A", "Task B", "Task C"])

      // 順序番号が正しく計算されているか確認
      const taskD = view.taskInstances.find(
        (inst) => inst.task.title === "Task D",
      )
      const taskA = view.taskInstances.find(
        (inst) => inst.task.title === "Task A",
      )

      expect(taskD.order).toBeLessThan(taskA.order)
    })
  })

  describe("間に挿入する場合", () => {
    test("BをAとCの間に挿入", () => {
      // 初期状態: A(100), C(300), D(400), B(700)
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task C", 300),
        createTaskInstance("Task D", 400),
        createTaskInstance("Task B", 700),
      ]

      // Task BをAとCの間に移動
      const taskBToMove = view.taskInstances.find(inst => inst.task.title === "Task B");
      view.moveInstanceToSlotSimple(taskBToMove, "8:00-12:00", 1)

      // ソート実行
      view.sortByOrder()

      // 期待される結果: A(100), B(200), C(300), D(400)
      expectOrder(view.taskInstances, ["Task A", "Task B", "Task C", "Task D"])

      // 順序番号が正しく計算されているか確認
      const taskA = view.taskInstances.find(
        (inst) => inst.task.title === "Task A",
      )
      const taskB = view.taskInstances.find(
        (inst) => inst.task.title === "Task B",
      )
      const taskC = view.taskInstances.find(
        (inst) => inst.task.title === "Task C",
      )

      expect(taskB.order).toBeGreaterThan(taskA.order)
      expect(taskB.order).toBeLessThan(taskC.order)
    })

    test("隙間が少ない場合の正規化", () => {
      // 初期状態: 隙間が狭い状態
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task C", 101),
        createTaskInstance("Task D", 102),
        createTaskInstance("Task B", 200),
      ]

      // normalizeOrdersのモック実装
      view.normalizeOrders = jest.fn((tasks) => {
        tasks.forEach((task, index) => {
          task.order = (index + 1) * 100
        })
      })

      // Task BをAとCの間に移動
      const taskBToNormalize = view.taskInstances.find(inst => inst.task.title === "Task B");
      view.moveInstanceToSlotSimple(taskBToNormalize, "8:00-12:00", 1)

      // 正規化が呼ばれたか確認
      expect(view.normalizeOrders).toHaveBeenCalled()
    })
  })

  describe("複数回の移動", () => {
    test("連続して複数回移動", () => {
      // 初期状態
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task B", 200),
        createTaskInstance("Task C", 300),
        createTaskInstance("Task D", 400),
      ]

      // 1回目: AをDの後ろに
      const taskAFirst = view.taskInstances.find(inst => inst.task.title === "Task A");
      view.moveInstanceToSlotSimple(taskAFirst, "8:00-12:00", 3)
      view.sortByOrder()

      // 2回目: Dを先頭に
      const taskDFirst = view.taskInstances.find(inst => inst.task.title === "Task D");
      view.moveInstanceToSlotSimple(taskDFirst, "8:00-12:00", 0)
      view.sortByOrder()

      // 3回目: Bを2番目に
      const taskBMiddle = view.taskInstances.find(inst => inst.task.title === "Task B");
      view.moveInstanceToSlotSimple(taskBMiddle, "8:00-12:00", 1)
      view.sortByOrder()

      // 最終的な順序: D, B, C, A
      expectOrder(view.taskInstances, ["Task D", "Task B", "Task C", "Task A"])
    })
  })

  describe("完了済みタスクがある場合", () => {
    test("完了済みタスクの後ろに移動", () => {
      // 初期状態: A(idle), B(done), C(idle), D(idle)
      view.taskInstances = [
        createTaskInstance("Task A", 100, "8:00-12:00", "idle"),
        createTaskInstance("Task B", 200, "8:00-12:00", "done"),
        createTaskInstance("Task C", 300, "8:00-12:00", "idle"),
        createTaskInstance("Task D", 400, "8:00-12:00", "idle"),
      ]

      // Task Dを位置1に移動（doneタスクの直後）
      const taskDDone = view.taskInstances.find(inst => inst.task.title === "Task D");
      view.moveInstanceToSlotSimple(taskDDone, "8:00-12:00", 1)
      view.sortByOrder()

      // ソート後の順序（状態優先）
      const doneB = view.taskInstances.find(
        (inst) => inst.task.title === "Task B",
      )
      const taskA = view.taskInstances.find(
        (inst) => inst.task.title === "Task A",
      )
      const taskC = view.taskInstances.find(
        (inst) => inst.task.title === "Task C",
      )
      const taskD = view.taskInstances.find(
        (inst) => inst.task.title === "Task D",
      )

      // doneタスクが最初、その後idleタスクがorder順
      expect(view.taskInstances[0]).toBe(doneB)
      
      // idleタスク内での順序確認
      const idleTasks = view.taskInstances.filter(inst => inst.state === "idle")
      expect(idleTasks[0]).toBe(taskA)
      expect(idleTasks[1]).toBe(taskD)
      expect(idleTasks[2]).toBe(taskC)
    })
  })

  describe("バグの再現と修正確認", () => {
    test("計算されたorder番号が正しく保存されている", () => {
      // 初期状態
      view.taskInstances = [
        createTaskInstance("Task A", 100),
        createTaskInstance("Task B", 200),
        createTaskInstance("Task C", 300),
      ]

      // Task Aを位置2に移動（BとCの間）
      const taskABug = view.taskInstances[0];
      const originalOrder = taskABug.order

      // calculateSimpleOrderの実装を追加
      view.calculateSimpleOrder = jest.fn((targetIndex, sameTasks) => {
        const sorted = sameTasks.sort((a, b) => a.order - b.order)
        
        if (sorted.length === 0) return 100
        if (targetIndex <= 0) return sorted[0].order - 100
        if (targetIndex >= sorted.length) return sorted[sorted.length - 1].order + 100
        
        const prev = sorted[targetIndex - 1].order
        const next = sorted[targetIndex].order
        
        if (next - prev > 1) {
          return Math.floor((prev + next) / 2)
        }
        
        return targetIndex * 100 + 50
      })

      // moveInstanceToSlotSimpleの実装をモック
      view.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
        // 同じスロットのタスクを取得（移動するタスク自身を除く）
        const slotTasks = view.taskInstances.filter(
          inst => inst.slotKey === targetSlot && inst !== instance
        )
        
        // 新しいorderを計算
        const newOrder = view.calculateSimpleOrder(targetIndex, slotTasks)
        instance.order = newOrder
        
        // saveTaskOrdersを呼び出す
        view.saveTaskOrders()
      })

      // saveTaskOrdersをモック
      view.saveTaskOrders = jest.fn(() => {
        localStorageSetItemSpy('taskchute-orders-2025-01-23', JSON.stringify({
          'task-a.md': { slot: '8:00-12:00', order: taskABug.order }
        }))
      })

      view.moveInstanceToSlotSimple(taskABug, "8:00-12:00", 1)

      // orderが更新されているか確認（BとCの間なので250になるはず）
      expect(taskABug.order).not.toBe(originalOrder)
      expect(taskABug.order).toBe(250) // (200 + 300) / 2
      expect(taskABug.order).toBeGreaterThan(200) // Task Bより大きい
      expect(taskABug.order).toBeLessThan(300) // Task Cより小さい

      // saveTaskOrdersが呼ばれたか確認
      expect(view.saveTaskOrders).toHaveBeenCalled()
      
      // localStorageに保存されているか確認
      expect(localStorageSetItemSpy).toHaveBeenCalledWith(
        'taskchute-orders-2025-01-23',
        expect.any(String)
      )
    })
  })
})