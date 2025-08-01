const { describe, test, expect, beforeEach } = require("@jest/globals")
const moment = require("moment")

describe("タスク実行時の並び替えバグ", () => {
  // sortTaskInstances関数を直接テスト
  test("実行済みタスクの直後に新規実行タスクが配置される", () => {
    // sortTaskInstances関数をインポート
    const { sortTaskInstances } = require("../main.js")
    const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
    
    // 現在時刻のモック
    const now = moment()
    
    // 初期状態：5つのタスクが8:00-12:00、1つが12:00-16:00
    let taskInstances = [
      {
        task: { title: "タスクA", path: "/task-a.md", scheduledTime: "08:30" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクB", path: "/task-b.md", scheduledTime: "09:00" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクC", path: "/task-c.md", scheduledTime: "10:00" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクD", path: "/task-d.md", scheduledTime: "10:30" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクE", path: "/task-e.md", scheduledTime: "11:00" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクF", path: "/task-f.md", scheduledTime: "13:00" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "12:00-16:00"
      }
    ]
    
    // タスクA,Bを実行・完了
    taskInstances[0].state = "done"
    taskInstances[0].startTime = now.clone().subtract(60, "minutes").toDate()
    taskInstances[0].stopTime = now.clone().subtract(50, "minutes").toDate()
    
    taskInstances[1].state = "done"
    taskInstances[1].startTime = now.clone().subtract(50, "minutes").toDate()
    taskInstances[1].stopTime = now.clone().subtract(40, "minutes").toDate()
    
    // タスクEを実行・完了
    taskInstances[4].state = "done"
    taskInstances[4].startTime = now.clone().subtract(40, "minutes").toDate()
    taskInstances[4].stopTime = now.clone().subtract(30, "minutes").toDate()
    
    // ソート実行
    let sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
    let slot8to12 = sortedInstances.filter(inst => inst.slotKey === "8:00-12:00")
    
    // 期待される並び順：A（完了）→B（完了）→E（完了）→C（未実施）→D（未実施）
    expect(slot8to12[0].task.title).toBe("タスクA")
    expect(slot8to12[0].state).toBe("done")
    expect(slot8to12[1].task.title).toBe("タスクB")
    expect(slot8to12[1].state).toBe("done")
    expect(slot8to12[2].task.title).toBe("タスクE")
    expect(slot8to12[2].state).toBe("done")
    expect(slot8to12[3].task.title).toBe("タスクC")
    expect(slot8to12[3].state).toBe("idle")
    expect(slot8to12[4].task.title).toBe("タスクD")
    expect(slot8to12[4].state).toBe("idle")
    
    // タスクFを12:00-16:00から8:00-12:00に移動して実行・完了
    taskInstances[5].slotKey = "8:00-12:00"
    taskInstances[5].state = "done"
    taskInstances[5].startTime = now.clone().subtract(30, "minutes").toDate()
    taskInstances[5].stopTime = now.clone().subtract(20, "minutes").toDate()
    
    // 再度ソート実行
    sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
    slot8to12 = sortedInstances.filter(inst => inst.slotKey === "8:00-12:00")
    
    // 期待される並び順：A→B→E→F（すべて完了、時系列順）→C→D（未実施）
    expect(slot8to12[0].task.title).toBe("タスクA")
    expect(slot8to12[0].state).toBe("done")
    expect(slot8to12[1].task.title).toBe("タスクB")
    expect(slot8to12[1].state).toBe("done")
    expect(slot8to12[2].task.title).toBe("タスクE")
    expect(slot8to12[2].state).toBe("done")
    expect(slot8to12[3].task.title).toBe("タスクF")
    expect(slot8to12[3].state).toBe("done")
    expect(slot8to12[4].task.title).toBe("タスクC")
    expect(slot8to12[4].state).toBe("idle")
    expect(slot8to12[5].task.title).toBe("タスクD")
    expect(slot8to12[5].state).toBe("idle")
  })
  
  test("実行中タスクも完了タスクの後に正しく配置される", () => {
    const { sortTaskInstances } = require("../main.js")
    const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
    const now = moment()
    
    let taskInstances = [
      {
        task: { title: "完了タスク1", path: "/done1.md" },
        state: "done",
        startTime: now.clone().subtract(30, "minutes").toDate(),
        stopTime: now.clone().subtract(20, "minutes").toDate(),
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "実行中タスク", path: "/running.md" },
        state: "running",
        startTime: now.clone().subtract(10, "minutes").toDate(),
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "未実施タスク", path: "/idle.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      }
    ]
    
    const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
    const titles = sortedInstances.map(inst => inst.task.title)
    
    // 期待される並び順：完了→実行中→未実施
    expect(titles).toEqual(["完了タスク1", "実行中タスク", "未実施タスク"])
  })
  
  test("開始ボタンを押した瞬間に実行中タスクが正しい位置に移動する", () => {
    const { sortTaskInstances } = require("../main.js")
    const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
    const now = moment()
    
    // 初期状態：完了タスクA,B + 未実施タスクC,D,E
    let taskInstances = [
      {
        task: { title: "タスクA", path: "/task-a.md" },
        state: "done",
        startTime: now.clone().subtract(60, "minutes").toDate(),
        stopTime: now.clone().subtract(50, "minutes").toDate(),
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクB", path: "/task-b.md" },
        state: "done",
        startTime: now.clone().subtract(50, "minutes").toDate(),
        stopTime: now.clone().subtract(40, "minutes").toDate(),
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクC", path: "/task-c.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクD", path: "/task-d.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクE", path: "/task-e.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      }
    ]
    
    // タスクEを実行開始（running状態に変更）
    taskInstances[4].state = "running"
    taskInstances[4].startTime = now.toDate()
    
    // ソート実行
    const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
    const slot8to12 = sortedInstances.filter(inst => inst.slotKey === "8:00-12:00")
    const titles = slot8to12.map(inst => inst.task.title)
    
    // 期待される並び順：A(完了)→B(完了)→E(実行中)→C(未実施)→D(未実施)
    expect(titles).toEqual(["タスクA", "タスクB", "タスクE", "タスクC", "タスクD"])
    expect(slot8to12[0].state).toBe("done")
    expect(slot8to12[1].state).toBe("done") 
    expect(slot8to12[2].state).toBe("running") // 実行中タスクが実行済みタスクの直後
    expect(slot8to12[3].state).toBe("idle")
    expect(slot8to12[4].state).toBe("idle")
  })

  test("異なる時間帯のタスクを実行すると現在の時間帯の実行済みタスクの直後に移動する", () => {
    const { sortTaskInstances } = require("../main.js")
    const timeSlotKeys = ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
    const now = moment()
    
    // 初期状態：8:00-12:00に完了タスクA,B + 未実施タスクC、12:00-16:00に未実施タスクF
    let taskInstances = [
      {
        task: { title: "タスクA", path: "/task-a.md" },
        state: "done",
        startTime: now.clone().subtract(60, "minutes").toDate(),
        stopTime: now.clone().subtract(50, "minutes").toDate(),
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクB", path: "/task-b.md" },
        state: "done",
        startTime: now.clone().subtract(50, "minutes").toDate(),
        stopTime: now.clone().subtract(40, "minutes").toDate(),
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクC", path: "/task-c.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00"
      },
      {
        task: { title: "タスクF", path: "/task-f.md" },
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "12:00-16:00",
        originalSlotKey: "12:00-16:00"
      }
    ]
    
    // タスクFを異なる時間帯（12:00-16:00）から現在の時間帯（8:00-12:00）に移動して実行開始
    taskInstances[3].slotKey = "8:00-12:00" // 現在の時間帯に移動
    taskInstances[3].state = "running"
    taskInstances[3].startTime = now.toDate()
    
    // ソート実行
    const sortedInstances = sortTaskInstances(taskInstances, timeSlotKeys)
    const slot8to12 = sortedInstances.filter(inst => inst.slotKey === "8:00-12:00")
    const slot12to16 = sortedInstances.filter(inst => inst.slotKey === "12:00-16:00")
    const titles8to12 = slot8to12.map(inst => inst.task.title)
    
    // 期待される並び順：A(完了)→B(完了)→F(実行中、12:00-16:00から移動)→C(未実施)
    expect(titles8to12).toEqual(["タスクA", "タスクB", "タスクF", "タスクC"])
    expect(slot8to12[0].state).toBe("done")
    expect(slot8to12[1].state).toBe("done") 
    expect(slot8to12[2].state).toBe("running") // 異なる時間帯から移動した実行中タスク
    expect(slot8to12[2].task.title).toBe("タスクF")
    expect(slot8to12[2].originalSlotKey).toBe("12:00-16:00") // 元の時間帯を記録
    expect(slot8to12[3].state).toBe("idle")
    
    // 12:00-16:00の時間帯は空になっているはず
    expect(slot12to16.length).toBe(0)
  })

})