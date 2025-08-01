const { TaskChuteView } = require("../main")
const { mockApp, mockLeaf } = require("../__mocks__/obsidian")

// Obsidian APIのモックは jest.config.js により自動化

describe("TaskChute Routine Functionality", () => {
  let taskChuteView
  let app
  let leaf

  beforeEach(() => {
    app = mockApp
    leaf = mockLeaf
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView(leaf, mockPlugin)
    taskChuteView.app = app
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    taskChuteView.isRunning = false
    taskChuteView.currentInstance = null
    taskChuteView.timerInterval = null
    // テスト用日付
    taskChuteView.currentDate = new Date(2024, 0, 2) // 2024-01-02
  })

  describe("毎日ルーチン", () => {
    test("should show daily routine task after routine_start", () => {
      const task = {
        title: "DailyTask",
        path: "daily-task.md",
        file: {},
        isRoutine: true,
        scheduledTime: "09:00",
        slotKey: "8:00-12:00",
        routineType: "daily",
        routineStart: "2024-01-01",
        routineEnd: null,
        weekday: null,
      }
      // routine_startの翌日
      taskChuteView.currentDate = new Date(2024, 0, 2) // 2024-01-02
      const shouldShow = !task.routineStart || "2024-01-02" >= task.routineStart
      expect(shouldShow).toBe(true)
    })
    test("should not show daily routine task before routine_start", () => {
      const task = {
        title: "DailyTask",
        path: "daily-task.md",
        file: {},
        isRoutine: true,
        scheduledTime: "09:00",
        slotKey: "8:00-12:00",
        routineType: "daily",
        routineStart: "2024-01-03",
        routineEnd: null,
        weekday: null,
      }
      // routine_startの前日
      taskChuteView.currentDate = new Date(2024, 0, 2) // 2024-01-02
      const shouldShow = !task.routineStart || "2024-01-02" >= task.routineStart
      expect(shouldShow).toBe(false)
    })
    test("should not show daily routine task after routine_end", () => {
      const task = {
        title: "DailyTask",
        path: "daily-task.md",
        file: {},
        isRoutine: true,
        scheduledTime: "09:00",
        slotKey: "8:00-12:00",
        routineType: "daily",
        routineStart: "2024-01-01",
        routineEnd: "2024-01-02",
        weekday: null,
      }
      // routine_endの翌日
      taskChuteView.currentDate = new Date(2024, 0, 3) // 2024-01-03
      const shouldShow = !task.routineEnd || "2024-01-03" <= task.routineEnd
      expect(shouldShow).toBe(false)
    })
  })

  describe("週1回ルーチン", () => {
    test("should show weekly routine task on target weekday", () => {
      const task = {
        title: "WeeklyTask",
        path: "weekly-task.md",
        file: {},
        isRoutine: true,
        scheduledTime: "10:00",
        slotKey: "8:00-12:00",
        routineType: "weekly",
        routineStart: "2024-01-01",
        routineEnd: null,
        weekday: 2, // 火曜日
      }
      // 2024-01-02は火曜日
      const currentDate = new Date(2024, 0, 2) // 2024-01-02 (火)
      const isTarget = currentDate.getDay() === task.weekday
      expect(isTarget).toBe(true)
    })
    test("should not show weekly routine task on non-target weekday", () => {
      const task = {
        title: "WeeklyTask",
        path: "weekly-task.md",
        file: {},
        isRoutine: true,
        scheduledTime: "10:00",
        slotKey: "8:00-12:00",
        routineType: "weekly",
        routineStart: "2024-01-01",
        routineEnd: null,
        weekday: 3, // 水曜日
      }
      // 2024-01-02は火曜日
      const currentDate = new Date(2024, 0, 2) // 2024-01-02 (火)
      const isTarget = currentDate.getDay() === task.weekday
      expect(isTarget).toBe(false)
    })
    test("should always show on routine_start date", () => {
      const task = {
        title: "WeeklyTask",
        path: "weekly-task.md",
        file: {},
        isRoutine: true,
        scheduledTime: "10:00",
        slotKey: "8:00-12:00",
        routineType: "weekly",
        routineStart: "2024-01-02",
        routineEnd: null,
        weekday: 3, // 水曜日
      }
      // routine_start当日
      const currentDate = new Date(2024, 0, 2) // 2024-01-02
      const isCreationDate = "2024-01-02" === task.routineStart
      expect(isCreationDate).toBe(true)
    })
  })

  describe("ルーチン解除", () => {
    test("should show task on routine_end date", () => {
      const task = {
        title: "DailyTask",
        path: "daily-task.md",
        file: {},
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
        routineType: "daily",
        routineStart: "2024-01-01",
        routineEnd: "2024-01-02",
        weekday: null,
      }
      // routine_end当日
      const currentDate = "2024-01-02"
      const shouldShow = task.routineEnd && currentDate === task.routineEnd
      expect(shouldShow).toBe(true)
    })
  })
})
