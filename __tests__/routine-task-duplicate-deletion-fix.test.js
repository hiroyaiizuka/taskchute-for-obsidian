const { ItemView, TFile, TFolder, Plugin, Notice } = require("obsidian")

describe("ルーチンタスク複製削除修正", () => {
  let view
  let plugin
  let mockApp
  let mockLeaf
  let mockVault
  let mockMetadataCache

  beforeEach(() => {
    // LocalStorage をクリア
    localStorage.clear()

    // モックの設定
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      modify: jest.fn(),
      create: jest.fn(),
      createFolder: jest.fn(),
    }

    mockMetadataCache = {
      getFileCache: jest.fn(),
    }

    mockApp = {
      vault: mockVault,
      metadataCache: mockMetadataCache,
    }

    mockLeaf = {
      view: null,
    }

    // Plugin のモック
    plugin = {
      pathManager: {
        getLogDataPath: jest.fn().mockReturnValue("TaskChute/Log/data"),
      },
    }

    // TaskChuteView のモック
    view = {
      app: mockApp,
      plugin: plugin,
      taskInstances: [],
      tasks: [],
      selectedTaskInstance: null,
      getCurrentDateString: jest.fn().mockReturnValue("2025-01-25"),
      saveHiddenRoutines: jest.fn(),
      getHiddenRoutines: jest.fn().mockReturnValue([]),
      renderTaskList: jest.fn(),
      saveRunningTasksState: jest.fn(),
      deleteTaskLogsByInstanceId: jest.fn().mockResolvedValue(),

      // 実際のメソッドを手動で実装（main.jsから抽出）
      isDuplicatedTask: function (inst, dateStr) {
        const duplicationKey = `taskchute-duplicated-instances-${dateStr}`
        try {
          const duplicatedInstances = JSON.parse(
            localStorage.getItem(duplicationKey) || "[]",
          )
          return duplicatedInstances.some(
            (dup) => dup.instanceId === inst.instanceId,
          )
        } catch (e) {
          console.error("[TaskChute] 複製タスク判定エラー:", e)
          return false
        }
      },

      // deleteRoutineTask の実装（修正版）
      async deleteRoutineTask(inst) {
        // 1. インスタンスをtaskInstancesから削除
        this.taskInstances = this.taskInstances.filter((i) => i !== inst)

        // 2. 複製されたタスクかどうかを判定
        const dateStr = this.getCurrentDateString()
        const isDuplicated = this.isDuplicatedTask(inst, dateStr)

        // 非表示リストに追加
        const hiddenRoutines = this.getHiddenRoutines(dateStr)
        const alreadyHidden = hiddenRoutines.some((hidden) => {
          // 複製タスクの判定
          if (isDuplicated) {
            return hidden.instanceId === inst.instanceId
          }

          // オリジナルタスクの判定
          if (typeof hidden === "string") {
            return hidden === inst.task.path
          }
          return hidden.path === inst.task.path && !hidden.instanceId
        })

        if (!alreadyHidden) {
          if (isDuplicated) {
            // 複製タスクの場合、必ずinstanceIdを含める
            hiddenRoutines.push({
              path: inst.task.path,
              instanceId: inst.instanceId,
            })
          } else {
            // オリジナルタスクの場合、instanceIdはnull
            hiddenRoutines.push({
              path: inst.task.path,
              instanceId: null,
            })
          }
          this.saveHiddenRoutines(dateStr, hiddenRoutines)
        }

        // 複製リストからも削除（複製の場合のみ）
        if (isDuplicated) {
          try {
            const duplicationKey = `taskchute-duplicated-instances-${dateStr}`
            let duplicatedInstances = JSON.parse(
              localStorage.getItem(duplicationKey) || "[]",
            )
            const beforeLength = duplicatedInstances.length
            duplicatedInstances = duplicatedInstances.filter(
              (dup) => dup.instanceId !== inst.instanceId,
            )

            // ログ出力で削除確認
            console.log(
              `[TaskChute] 複製リストから削除: ${beforeLength} -> ${duplicatedInstances.length}`,
            )

            localStorage.setItem(
              duplicationKey,
              JSON.stringify(duplicatedInstances),
            )
          } catch (e) {
            console.error("[TaskChute] 複製情報の更新に失敗:", e)
          }
        }

        // 3. 【重要な修正】複製タスクの場合はTaskExecutionsからも削除
        if (isDuplicated && inst.instanceId) {
          try {
            console.log(
              `[TaskChute] 複製タスクのTaskExecutions削除開始: ${inst.instanceId}`,
            )
            await this.deleteTaskLogsByInstanceId(
              inst.task.path,
              inst.instanceId,
            )
            console.log(
              `[TaskChute] 複製タスクのTaskExecutions削除完了: ${inst.instanceId}`,
            )
          } catch (e) {
            console.error("[TaskChute] TaskExecutions削除に失敗:", e)
          }
        }

        // 4. 実行中タスクの場合は running-task.json を更新
        if (inst.state === "running") {
          await this.saveRunningTasksState()
        }

        this.renderTaskList()

        if (isDuplicated) {
          global.Notice(
            `「${inst.task.title}」の複製を本日のリストから削除しました。`,
          )
        } else {
          global.Notice(
            `「${inst.task.title}」を本日のリストから削除しました。\n（他の日付には影響しません）`,
          )
        }
      },
    }

    // Notice のモック
    global.Notice = jest.fn()
  })

  afterEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
  })

  describe("完了済みルーチンタスクの削除", () => {
    test("完了済みルーチンタスクを削除できる（制限撤廃）", async () => {
      const completedRoutineTask = {
        task: {
          title: "完了済みルーチンタスク",
          path: "TaskChute/Task/完了済みルーチンタスク.md",
          isRoutine: true,
        },
        state: "done", // 完了済み
        instanceId: "completed-routine-task-1",
      }

      view.taskInstances = [completedRoutineTask]

      // deleteRoutineTask を実行
      await view.deleteRoutineTask(completedRoutineTask)

      // taskInstances から削除されることを確認
      expect(view.taskInstances).toHaveLength(0)

      // saveHiddenRoutines が呼ばれることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith("2025-01-25", [
        {
          path: "TaskChute/Task/完了済みルーチンタスク.md",
          instanceId: null,
        },
      ])

      // 通知メッセージを確認
      expect(global.Notice).toHaveBeenCalledWith(
        "「完了済みルーチンタスク」を本日のリストから削除しました。\n（他の日付には影響しません）",
      )
    })

    test("複製された完了済みタスクも削除できる", async () => {
      const duplicatedCompletedTask = {
        task: {
          title: "複製完了済みタスク",
          path: "TaskChute/Task/複製完了済みタスク.md",
          isRoutine: true,
        },
        state: "done", // 完了済み
        instanceId: "duplicated-completed-task-1",
      }

      view.taskInstances = [duplicatedCompletedTask]

      // 複製リストのモック
      const duplicatedInstances = [
        {
          path: "TaskChute/Task/複製完了済みタスク.md",
          instanceId: "duplicated-completed-task-1",
        },
      ]
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-25",
        JSON.stringify(duplicatedInstances),
      )

      // deleteRoutineTask を実行
      await view.deleteRoutineTask(duplicatedCompletedTask)

      // taskInstances から削除されることを確認
      expect(view.taskInstances).toHaveLength(0)

      // TaskExecutions からの削除が呼ばれることを確認
      expect(view.deleteTaskLogsByInstanceId).toHaveBeenCalledWith(
        "TaskChute/Task/複製完了済みタスク.md",
        "duplicated-completed-task-1",
      )

      // 複製リストから削除されることを確認
      const updatedDuplicatedInstances = JSON.parse(
        localStorage.getItem("taskchute-duplicated-instances-2025-01-25") ||
          "[]",
      )
      expect(updatedDuplicatedInstances).toHaveLength(0)

      // 通知メッセージを確認
      expect(global.Notice).toHaveBeenCalledWith(
        "「複製完了済みタスク」の複製を本日のリストから削除しました。",
      )
    })
  })

  describe("複製タスクの独立性", () => {
    test("複製タスクを削除してもオリジナルタスクに影響しない", async () => {
      const originalTask = {
        task: {
          title: "オリジナルタスク",
          path: "TaskChute/Task/オリジナルタスク.md",
          isRoutine: true,
        },
        state: "done",
        instanceId: "original-task-1",
      }

      const duplicatedTask = {
        task: {
          title: "オリジナルタスク",
          path: "TaskChute/Task/オリジナルタスク.md",
          isRoutine: true,
        },
        state: "done",
        instanceId: "duplicated-task-1",
      }

      view.taskInstances = [originalTask, duplicatedTask]

      // 複製リストのモック
      const duplicatedInstances = [
        {
          path: "TaskChute/Task/オリジナルタスク.md",
          instanceId: "duplicated-task-1",
        },
      ]
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-25",
        JSON.stringify(duplicatedInstances),
      )

      // 複製タスクを削除
      await view.deleteRoutineTask(duplicatedTask)

      // オリジナルタスクは残り、複製タスクのみが削除されることを確認
      expect(view.taskInstances).toHaveLength(1)
      expect(view.taskInstances[0]).toBe(originalTask)

      // 複製タスクのみが非表示リストに追加されることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith("2025-01-25", [
        {
          path: "TaskChute/Task/オリジナルタスク.md",
          instanceId: "duplicated-task-1",
        },
      ])

      // TaskExecutions からの削除が複製タスクのみに適用されることを確認
      expect(view.deleteTaskLogsByInstanceId).toHaveBeenCalledWith(
        "TaskChute/Task/オリジナルタスク.md",
        "duplicated-task-1",
      )
    })

    test("オリジナルタスクを削除しても複製タスクに影響しない", async () => {
      const originalTask = {
        task: {
          title: "オリジナルタスク",
          path: "TaskChute/Task/オリジナルタスク.md",
          isRoutine: true,
        },
        state: "idle",
        instanceId: "original-task-1",
      }

      const duplicatedTask = {
        task: {
          title: "オリジナルタスク",
          path: "TaskChute/Task/オリジナルタスク.md",
          isRoutine: true,
        },
        state: "idle",
        instanceId: "duplicated-task-1",
      }

      view.taskInstances = [originalTask, duplicatedTask]

      // 複製リストのモック
      const duplicatedInstances = [
        {
          path: "TaskChute/Task/オリジナルタスク.md",
          instanceId: "duplicated-task-1",
        },
      ]
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-25",
        JSON.stringify(duplicatedInstances),
      )

      // オリジナルタスクを削除
      await view.deleteRoutineTask(originalTask)

      // 複製タスクは残り、オリジナルタスクのみが削除されることを確認
      expect(view.taskInstances).toHaveLength(1)
      expect(view.taskInstances[0]).toBe(duplicatedTask)

      // オリジナルタスクのみが非表示リストに追加されることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith("2025-01-25", [
        {
          path: "TaskChute/Task/オリジナルタスク.md",
          instanceId: null,
        },
      ])

      // TaskExecutions からの削除は呼ばれない（オリジナルタスクは複製ではないため）
      expect(view.deleteTaskLogsByInstanceId).not.toHaveBeenCalled()
    })
  })

  describe("instanceId管理", () => {
    test("複製タスクのinstanceIdが正しく管理される", async () => {
      const duplicatedTask = {
        task: {
          title: "複製タスク",
          path: "TaskChute/Task/複製タスク.md",
          isRoutine: true,
        },
        state: "idle",
        instanceId: "unique-instance-id-123",
      }

      view.taskInstances = [duplicatedTask]

      // 複製リストのモック
      const duplicatedInstances = [
        {
          path: "TaskChute/Task/複製タスク.md",
          instanceId: "unique-instance-id-123",
        },
      ]
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-25",
        JSON.stringify(duplicatedInstances),
      )

      await view.deleteRoutineTask(duplicatedTask)

      // 非表示リストでinstanceIdが正しく管理されることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith("2025-01-25", [
        {
          path: "TaskChute/Task/複製タスク.md",
          instanceId: "unique-instance-id-123",
        },
      ])

      // 複製リストから正しく削除されることを確認
      const updatedDuplicatedInstances = JSON.parse(
        localStorage.getItem("taskchute-duplicated-instances-2025-01-25") ||
          "[]",
      )
      expect(updatedDuplicatedInstances).toHaveLength(0)
    })
  })

  describe("データ整合性", () => {
    test("localStorage内のデータが正しく更新される", async () => {
      const duplicatedTask = {
        task: {
          title: "データ整合性テスト",
          path: "TaskChute/Task/データ整合性テスト.md",
          isRoutine: true,
        },
        state: "done",
        instanceId: "consistency-test-1",
      }

      view.taskInstances = [duplicatedTask]

      // 複製リストの初期状態
      const initialDuplicatedInstances = [
        {
          path: "TaskChute/Task/データ整合性テスト.md",
          instanceId: "consistency-test-1",
        },
        { path: "TaskChute/Task/他のタスク.md", instanceId: "other-task-1" },
      ]
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-25",
        JSON.stringify(initialDuplicatedInstances),
      )

      await view.deleteRoutineTask(duplicatedTask)

      // 削除対象のタスクのみが複製リストから削除されることを確認
      const updatedDuplicatedInstances = JSON.parse(
        localStorage.getItem("taskchute-duplicated-instances-2025-01-25") ||
          "[]",
      )
      expect(updatedDuplicatedInstances).toHaveLength(1)
      expect(updatedDuplicatedInstances[0].instanceId).toBe("other-task-1")

      // 非表示リストには正しく追加されることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith("2025-01-25", [
        {
          path: "TaskChute/Task/データ整合性テスト.md",
          instanceId: "consistency-test-1",
        },
      ])
    })
  })

  describe("当日の削除が他の日付に影響しないこと", () => {
    test("削除が当日のみに影響することを確認", async () => {
      const routineTask = {
        task: {
          title: "日付独立テスト",
          path: "TaskChute/Task/日付独立テスト.md",
          isRoutine: true,
        },
        state: "idle",
        instanceId: "date-independent-test-1",
      }

      view.taskInstances = [routineTask]

      // 異なる日付の複製リストが存在することを確認
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-24",
        JSON.stringify([
          {
            path: "TaskChute/Task/日付独立テスト.md",
            instanceId: "yesterday-task",
          },
        ]),
      )
      localStorage.setItem(
        "taskchute-duplicated-instances-2025-01-26",
        JSON.stringify([
          {
            path: "TaskChute/Task/日付独立テスト.md",
            instanceId: "tomorrow-task",
          },
        ]),
      )

      await view.deleteRoutineTask(routineTask)

      // 他の日付のデータが影響を受けないことを確認
      expect(
        localStorage.getItem("taskchute-duplicated-instances-2025-01-24"),
      ).not.toBeNull()
      expect(
        localStorage.getItem("taskchute-duplicated-instances-2025-01-26"),
      ).not.toBeNull()

      // 当日のhidden-routinesが呼ばれることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith(
        "2025-01-25",
        expect.any(Array),
      )
    })
  })
})
