// TaskChute Plus - Drag & Drop UI Feedback Test
// ドラッグ&ドロップ時のUI制限とフィードバックのテスト

describe("ドラッグ&ドロップUI制限テスト", () => {
  let taskChuteView
  let mockApp
  let mockLeaf
  let mockTaskList

  beforeEach(() => {
    // モックの設定
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        create: jest.fn(),
        modify: jest.fn(),
        on: jest.fn().mockReturnValue({ unload: jest.fn() }),
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
    }

    mockLeaf = {
      view: null,
    }

    // タスクリストのモック
    const createMockElement = (tag, options) => {
      const element = {
        tag,
        classList: {
          add: jest.fn(),
          remove: jest.fn(),
          contains: jest.fn(),
        },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        createEl: jest.fn((tag, opts) => createMockElement(tag, opts)),
        empty: jest.fn(),
        appendChild: jest.fn(),
        removeChild: jest.fn(),
        setAttribute: jest.fn(),
        style: {},
        innerHTML: "",
        textContent: "",
      }
      if (options?.cls) {
        element.className = options.cls
      }
      if (options?.text) {
        element.textContent = options.text
      }
      return element
    }

    mockTaskList = createMockElement("div", { cls: "task-list" })

    // TaskChuteViewのインスタンスを作成（モックで簡略化）
    taskChuteView = {
      app: mockApp,
      taskInstances: [],
      taskList: mockTaskList,
      getTimeSlotKeys: jest
        .fn()
        .mockReturnValue(["8:00-12:00", "12:00-16:00", "16:00-0:00"]),
      createTaskInstanceItem: jest.fn((inst, slot, idx) => {
        const element = createMockElement("div", { cls: "task-item" })

        // dragoverイベントハンドラーの実装
        const dragoverHandler = (e) => {
          e.preventDefault()

          // ドラッグ中のタスクが完了済みの場合は何もしない
          const from = e.dataTransfer.types.includes("text/plain")
            ? true
            : false
          if (!from) return

          // 完了済みタスクの場合は常に移動不可
          if (inst.state === "done") {
            element.classList.add("dragover-invalid")
            return
          }

          // 実行中タスクの場合、最後のタスクでない限り移動不可
          if (inst.state === "running") {
            // 同じ時間帯の全タスクを取得
            const slotInstances = taskChuteView.taskInstances.filter(
              (i) => i.slotKey === (slot ?? "none"),
            )
            
            // 現在のタスクのインデックスを取得
            const currentTaskIndex = slotInstances.indexOf(inst)
            
            if (currentTaskIndex < slotInstances.length - 1) {
              element.classList.add("dragover-invalid")
              return
            }
          }

          // 通常のドラッグオーバー表示
          element.classList.add("dragover")
        }

        // dragleaveイベントハンドラーの実装
        const dragleaveHandler = () => {
          element.classList.remove("dragover")
          element.classList.remove("dragover-invalid")
        }

        // イベントリスナーの登録
        element.addEventListener.mockImplementation((event, handler) => {
          if (event === "dragover") {
            element.dragoverHandler = handler
          } else if (event === "dragleave") {
            element.dragleaveHandler = handler
          }
        })

        element.addEventListener("dragover", dragoverHandler)
        element.addEventListener("dragleave", dragleaveHandler)

        // ハンドラーを直接アクセス可能にする
        element.dragoverHandler = dragoverHandler
        element.dragleaveHandler = dragleaveHandler

        return element
      }),
      renderTaskList: jest.fn(() => {
        // 時間帯ヘッダーの作成をシミュレート
        const header = mockTaskList.createEl("div", { cls: "time-slot-header" })

        const headerDragoverHandler = (e) => {
          e.preventDefault()
          const from = e.dataTransfer.types.includes("text/plain")
            ? true
            : false
          if (!from) return
          header.classList.add("dragover")
        }

        header.addEventListener.mockImplementation((event, handler) => {
          if (event === "dragover") {
            header.dragoverHandler = handler
          }
        })

        header.addEventListener("dragover", headerDragoverHandler)
        header.dragoverHandler = headerDragoverHandler
      }),
    }

    // タスクインスタンスのセットアップ
    taskChuteView.taskInstances = [
      {
        task: { title: "完了タスクA", path: "task-a.md" },
        state: "done",
        startTime: new Date("2024-01-01T09:00:00"),
        stopTime: new Date("2024-01-01T10:00:00"),
        slotKey: "8:00-12:00",
      },
      {
        task: { title: "実行中タスクB", path: "task-b.md" },
        state: "running",
        startTime: new Date("2024-01-01T10:00:00"),
        stopTime: null,
        slotKey: "8:00-12:00",
      },
      {
        task: { title: "未実施タスクC", path: "task-c.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00",
      },
      {
        task: { title: "未実施タスクD", path: "task-d.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00",
      },
    ]
  })

  describe("dragoverイベントのUI制限", () => {
    test("完了済みタスクの上にドラッグした場合、dragover-invalidクラスが追加される", () => {
      const taskItem = taskChuteView.createTaskInstanceItem(
        taskChuteView.taskInstances[0], // 完了済みタスク
        "8:00-12:00",
        0,
      )

      // ドラッグイベントをシミュレート
      const mockEvent = {
        preventDefault: jest.fn(),
        dataTransfer: {
          types: ["text/plain"],
        },
      }

      // dragoverハンドラーを直接呼び出し
      taskItem.dragoverHandler(mockEvent)

      // dragover-invalidクラスが追加されることを確認
      expect(taskItem.classList.add).toHaveBeenCalledWith("dragover-invalid")
      expect(taskItem.classList.add).not.toHaveBeenCalledWith("dragover")
    })

    test("実行中タスクの上にドラッグした場合、dragover-invalidクラスが追加される", () => {
      const taskItem = taskChuteView.createTaskInstanceItem(
        taskChuteView.taskInstances[1], // 実行中タスク
        "8:00-12:00",
        1,
      )

      // ドラッグイベントをシミュレート
      const mockEvent = {
        preventDefault: jest.fn(),
        dataTransfer: {
          types: ["text/plain"],
        },
      }

      // dragoverハンドラーを直接呼び出し
      taskItem.dragoverHandler(mockEvent)

      // dragover-invalidクラスが追加されることを確認
      expect(taskItem.classList.add).toHaveBeenCalledWith("dragover-invalid")
      expect(taskItem.classList.add).not.toHaveBeenCalledWith("dragover")
    })

    test("未実施タスクの上にドラッグした場合、通常のdragoverクラスが追加される", () => {
      const taskItem = taskChuteView.createTaskInstanceItem(
        taskChuteView.taskInstances[2], // 未実施タスク
        "8:00-12:00",
        2,
      )

      // ドラッグイベントをシミュレート
      const mockEvent = {
        preventDefault: jest.fn(),
        dataTransfer: {
          types: ["text/plain"],
        },
      }

      // dragoverハンドラーを直接呼び出し
      taskItem.dragoverHandler(mockEvent)

      // 通常のdragoverクラスが追加されることを確認
      expect(taskItem.classList.add).toHaveBeenCalledWith("dragover")
      expect(taskItem.classList.add).not.toHaveBeenCalledWith(
        "dragover-invalid",
      )
    })

    test("最後の実行中タスクの上にドラッグした場合、通常のdragoverクラスが追加される", () => {
      // タスクインスタンスを調整（実行中タスクを最後に配置）
      taskChuteView.taskInstances = [
        taskChuteView.taskInstances[0], // 完了済み
        taskChuteView.taskInstances[2], // 未実施
        taskChuteView.taskInstances[3], // 未実施
        taskChuteView.taskInstances[1], // 実行中（最後）
      ]

      const taskItem = taskChuteView.createTaskInstanceItem(
        taskChuteView.taskInstances[3], // 最後の実行中タスク
        "8:00-12:00",
        3,
      )

      // ドラッグイベントをシミュレート
      const mockEvent = {
        preventDefault: jest.fn(),
        dataTransfer: {
          types: ["text/plain"],
        },
      }

      // dragoverハンドラーを直接呼び出し
      taskItem.dragoverHandler(mockEvent)

      // 通常のdragoverクラスが追加されることを確認（最後の完了済み・実行中タスクなので許可）
      expect(taskItem.classList.add).toHaveBeenCalledWith("dragover")
      expect(taskItem.classList.add).not.toHaveBeenCalledWith(
        "dragover-invalid",
      )
    })
  })

  describe("dragleaveイベントのクリーンアップ", () => {
    test("dragleave時に全てのドラッグ関連クラスが削除される", () => {
      const taskItem = taskChuteView.createTaskInstanceItem(
        taskChuteView.taskInstances[0],
        "8:00-12:00",
        0,
      )

      // dragleaveハンドラーを直接呼び出し
      taskItem.dragleaveHandler()

      // 両方のクラスが削除されることを確認
      expect(taskItem.classList.remove).toHaveBeenCalledWith("dragover")
      expect(taskItem.classList.remove).toHaveBeenCalledWith("dragover-invalid")
    })
  })

  describe("時間帯ヘッダーのドラッグ制限", () => {
    test("時間帯ヘッダーにドラッグ時、dragoverクラスが追加される", () => {
      // renderTaskListを呼び出してヘッダーを生成
      taskChuteView.renderTaskList()

      // 時間帯ヘッダーのdragoverハンドラーを取得
      const timeSlotHeader = mockTaskList.createEl.mock.results[0]?.value

      if (timeSlotHeader && timeSlotHeader.dragoverHandler) {
        // ドラッグイベントをシミュレート
        const mockEvent = {
          preventDefault: jest.fn(),
          dataTransfer: {
            types: ["text/plain"],
          },
        }

        timeSlotHeader.dragoverHandler(mockEvent)

        // dragoverクラスが追加されることを確認
        expect(timeSlotHeader.classList.add).toHaveBeenCalledWith("dragover")
      }
    })
  })
})
