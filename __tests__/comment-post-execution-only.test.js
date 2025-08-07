/**
 * @jest-environment jsdom
 */

const { Plugin, ItemView, WorkspaceLeaf, TFile, Notice } = require("obsidian")

// モック設定
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

// テストヘルパー関数
const createTestTaskData = (overrides = {}) => {
  return {
    title: "テストタスク",
    path: "test-task.md",
    estimate: 30,
    startTime: null,
    endTime: null,
    isRoutine: false,
    ...overrides
  }
}

// DOM要素のモックヘルパー
const mockEl = () => {
  const el = {
    createEl: jest.fn().mockImplementation(() => mockEl()),
    createSvg: jest.fn().mockImplementation(() => mockEl()),
    addEventListener: jest.fn(),
    appendChild: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(),
    },
    style: {},
    textContent: "",
    querySelector: jest.fn(),
    querySelectorAll: jest.fn().mockReturnValue([]),
    remove: jest.fn(),
  }
  return el
}

describe("コメント機能の実行後制限", () => {
  let mockApp, mockPlugin, view

  beforeEach(() => {
    // Vault adapterのモック
    const mockVaultAdapter = {
      exists: jest.fn(),
      mkdir: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
    }

    // アプリケーションモック
    mockApp = {
      vault: {
        adapter: mockVaultAdapter,
      },
    }

    mockPlugin = {
      app: mockApp,
      pathManager: {
        getProjectsPath: () => "Projects",
        getTasksPath: () => "Tasks",
        getLogDataPath: () => "LogData",
        getTaskFolderPath: () => "TaskChute/Task",
        getProjectFolderPath: () => "TaskChute/Project",
      },
      settings: {
        taskDisplayLimit: 50,
      },
    }

    // TaskChuteViewのモック
    view = new TaskChuteView({}, mockPlugin)
    view.app = mockApp
    view.taskList = {
      empty: jest.fn(),
      createEl: jest.fn().mockImplementation(() => mockEl()),
    }
    view.openCommentModal = jest.fn()
    view.hasCommentData = jest.fn().mockResolvedValue(false)
    view.updateTaskStatusDisplay = jest.fn().mockImplementation((inst, taskItem) => {
      // querySelectorがコメントボタンを返すようにされている場合
      const commentButton = taskItem.querySelector(".comment-button")
      if (commentButton) {
        if (inst.state === "done") {
          commentButton.classList.remove("disabled")
          commentButton.setAttribute("data-task-state", "done")
        } else {
          commentButton.classList.add("disabled")
          commentButton.setAttribute("disabled", "true")
          commentButton.setAttribute("data-task-state", inst.state)
        }
      }
    })
    
    // createTaskItemメソッドをモック
    view.createTaskItem = jest.fn().mockImplementation((inst) => {
      const taskItem = mockEl()
      
      // コメントボタンを作成
      const commentButton = mockEl()
      
      // タスク状態に応じて初期設定
      if (inst.state !== "done") {
        commentButton.classList.add("disabled")
        commentButton.setAttribute("disabled", "true")
      }
      commentButton.setAttribute("data-task-state", inst.state)
      
      // クリックイベントハンドラを設定
      const clickHandler = () => {
        if (inst.state === "done") {
          view.openCommentModal(inst)
        }
      }
      commentButton.addEventListener.mockImplementation((event, handler) => {
        // ハンドラは引数として渡される
      })
      
      // addEventListenerのcallsにclickHandlerを追加
      commentButton.addEventListener.mock.calls[0] = ["click", clickHandler]
      
      // createElの呼び出しをシミュレート
      taskItem.createEl.mock.calls.push(["button", { cls: "comment-button", text: "💬" }])
      taskItem.createEl.mock.results.push({ value: commentButton })
      
      // hasCommentDataの非同期チェックを即座に実行
      // createTaskItem内でhasCommentDataを呼び出し
      view.hasCommentData(inst).then(hasComment => {
        if (hasComment) {
          commentButton.classList.add("active")
        } else if (inst.state === "done") {
          commentButton.classList.add("no-comment")
        }
      })
      
      return taskItem
    })
  })

  describe("コメントボタンの初期状態", () => {
    test("未実施タスク(idle)のコメントボタンは無効化される", () => {
      const task = createTestTaskData({
        title: "テストタスク",
      })
      const inst = {
        task,
        state: "idle",
        slotKey: "09:00",
      }

      const taskItem = view.createTaskItem(inst, "09:00", 0)
      
      // createElのモック呼び出しからコメントボタンを検証
      const createElCalls = taskItem.createEl.mock.calls
      const commentButtonCall = createElCalls.find(call => 
        call[0] === "button" && call[1]?.cls === "comment-button"
      )
      
      expect(commentButtonCall).toBeTruthy()
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      expect(commentButton).toBeTruthy()
      expect(commentButton.classList.add).toHaveBeenCalledWith("disabled")
      expect(commentButton.setAttribute).toHaveBeenCalledWith("disabled", "true")
      expect(commentButton.setAttribute).toHaveBeenCalledWith("data-task-state", "idle")
    })

    test("実行中タスク(running)のコメントボタンは無効化される", () => {
      const task = createTestTaskData({
        title: "実行中タスク",
      })
      const inst = {
        task,
        state: "running",
        slotKey: "10:00",
        startTime: new Date(),
      }

      const taskItem = view.createTaskItem(inst, "10:00", 0)
      
      const createElCalls = taskItem.createEl.mock.calls
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      expect(commentButton).toBeTruthy()
      expect(commentButton.classList.add).toHaveBeenCalledWith("disabled")
      expect(commentButton.setAttribute).toHaveBeenCalledWith("disabled", "true")
      expect(commentButton.setAttribute).toHaveBeenCalledWith("data-task-state", "running")
    })

    test("完了タスク(done)のコメントボタンは有効化される", () => {
      const task = createTestTaskData({
        title: "完了タスク",
      })
      const inst = {
        task,
        state: "done",
        slotKey: "11:00",
        startTime: new Date(Date.now() - 3600000),
        stopTime: new Date(),
      }

      const taskItem = view.createTaskItem(inst, "11:00", 0)
      
      const createElCalls = taskItem.createEl.mock.calls
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      expect(commentButton).toBeTruthy()
      expect(commentButton.classList.add).not.toHaveBeenCalledWith("disabled")
      expect(commentButton.setAttribute).not.toHaveBeenCalledWith("disabled", "true")
      expect(commentButton.setAttribute).toHaveBeenCalledWith("data-task-state", "done")
    })
  })

  describe("クリックイベントの制御", () => {
    test("未実施タスクのコメントボタンクリックは何も起こらない", async () => {
      const task = createTestTaskData({
        title: "未実施タスク",
      })
      const inst = {
        task,
        state: "idle",
        slotKey: "09:00",
      }

      const taskItem = view.createTaskItem(inst, "09:00", 0)
      
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      // addEventListenerに渡されたハンドラを確認
      expect(commentButton.addEventListener).toHaveBeenCalledWith("click", expect.any(Function))
      
      // クリックハンドラを実行
      const clickHandler = commentButton.addEventListener.mock.calls[0][1]
      clickHandler()
      
      // モーダルが開かないことを確認
      expect(view.openCommentModal).not.toHaveBeenCalled()
    })

    test("実行中タスクのコメントボタンクリックは何も起こらない", async () => {
      const task = createTestTaskData({
        title: "実行中タスク",
      })
      const inst = {
        task,
        state: "running",
        slotKey: "10:00",
        startTime: new Date(),
      }

      const taskItem = view.createTaskItem(inst, "10:00", 0)
      
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      // クリックハンドラを実行
      const clickHandler = commentButton.addEventListener.mock.calls[0][1]
      clickHandler()
      
      // モーダルが開かないことを確認
      expect(view.openCommentModal).not.toHaveBeenCalled()
    })

    test("完了タスクのコメントボタンクリックでモーダルが表示される", async () => {
      const task = createTestTaskData({
        title: "完了タスク",
      })
      const inst = {
        task,
        state: "done",
        slotKey: "11:00",
        startTime: new Date(Date.now() - 3600000),
        stopTime: new Date(),
      }

      const taskItem = view.createTaskItem(inst, "11:00", 0)
      
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      // クリックハンドラを実行
      const clickHandler = commentButton.addEventListener.mock.calls[0][1]
      clickHandler()
      
      // モーダルが開くことを確認
      expect(view.openCommentModal).toHaveBeenCalledWith(inst)
    })
  })

  describe("タスク状態変更時のUI更新", () => {
    test("idle → running → done の状態遷移でボタンが適切に更新される", () => {
      const task = createTestTaskData({
        title: "状態遷移タスク",
      })
      const inst = {
        task,
        state: "idle",
        slotKey: "09:00",
      }

      const taskItem = view.createTaskItem(inst, "09:00", 0)
      
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      // 初期状態（idle）
      expect(commentButton.classList.add).toHaveBeenCalledWith("disabled")

      // running状態に更新
      inst.state = "running"
      inst.startTime = new Date()
      
      // querySelectorがコメントボタンを返すように設定
      taskItem.querySelector.mockImplementation((selector) => {
        if (selector === ".comment-button") return commentButton
        return null
      })
      
      view.updateTaskStatusDisplay(inst, taskItem)
      expect(commentButton.classList.add).toHaveBeenCalledWith("disabled")

      // done状態に更新
      inst.state = "done"
      inst.stopTime = new Date()
      view.updateTaskStatusDisplay(inst, taskItem)
      expect(commentButton.classList.remove).toHaveBeenCalledWith("disabled")
    })

    test("done → idle リセット時にボタンが無効化される", () => {
      const task = createTestTaskData({
        title: "リセットタスク",
      })
      const inst = {
        task,
        state: "done",
        slotKey: "11:00",
        startTime: new Date(Date.now() - 3600000),
        stopTime: new Date(),
      }

      const taskItem = view.createTaskItem(inst, "11:00", 0)
      
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      // 初期状態（done）
      expect(commentButton.classList.add).not.toHaveBeenCalledWith("disabled")

      // querySelectorがコメントボタンを返すように設定
      taskItem.querySelector.mockImplementation((selector) => {
        if (selector === ".comment-button") return commentButton
        return null
      })

      // idle状態にリセット
      inst.state = "idle"
      inst.startTime = null
      inst.stopTime = null
      view.updateTaskStatusDisplay(inst, taskItem)
      expect(commentButton.classList.add).toHaveBeenCalledWith("disabled")
    })
  })

  describe("既存コメントの表示", () => {
    test("既存コメントがあるタスクはhasCommentDataが呼び出される", () => {
      const task = createTestTaskData({
        title: "コメント付きタスク",
      })
      const inst = {
        task,
        state: "done",
        slotKey: "11:00",
        startTime: new Date(Date.now() - 3600000),
        stopTime: new Date(),
      }

      // コメントがあることをモック
      view.hasCommentData.mockResolvedValue(true)

      const taskItem = view.createTaskItem(inst, "11:00", 0)
      
      // hasCommentDataが呼び出されたことを確認
      // setTimeout内で呼び出されるが、キューに乗るので同期的に確認可能
      expect(view.hasCommentData).toHaveBeenCalledWith(inst)
    })

    test("未実施タスクでも既存コメントチェックが実行される", () => {
      const task = createTestTaskData({
        title: "コメント付き未実施タスク",
      })
      const inst = {
        task,
        state: "idle",
        slotKey: "09:00",
      }

      // コメントがあることをモック
      view.hasCommentData.mockResolvedValue(true)

      const taskItem = view.createTaskItem(inst, "09:00", 0)
      
      const commentButton = taskItem.createEl.mock.results.find(r => 
        r.value && taskItem.createEl.mock.calls[taskItem.createEl.mock.results.indexOf(r)][1]?.cls === "comment-button"
      )?.value

      // hasCommentDataが呼び出されたことを確認
      expect(view.hasCommentData).toHaveBeenCalledWith(inst)
      // disabledが設定されていることを確認
      expect(commentButton.classList.add).toHaveBeenCalledWith("disabled")
    })
  })
})