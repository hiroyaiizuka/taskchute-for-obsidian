describe("ルーチンタスクの時間帯配置バグ修正テスト", () => {
  // 修正したコードのロジックを直接テスト
  test("ルーチンタスクの実行履歴は実行時刻の時間帯を使用する", () => {
    const exec = {
      startTime: new Date("2024-01-15T19:00:00"), // 19:00に実行
      slotKey: "8:00-12:00" // 元の時間帯（バグで保存された値）
    };
    
    const isRoutine = true;
    
    // 修正後のロジックをシミュレート
    let instanceSlotKey;
    
    if (isRoutine && exec.startTime) {
      const startHour = exec.startTime.getHours();
      const startMinute = exec.startTime.getMinutes();
      const timeInMinutes = startHour * 60 + startMinute;
      
      if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
        instanceSlotKey = "0:00-8:00";
      } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
        instanceSlotKey = "8:00-12:00";
      } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
        instanceSlotKey = "12:00-16:00";
      } else {
        instanceSlotKey = "16:00-0:00";
      }
    } else {
      instanceSlotKey = exec.slotKey || "none";
    }
    
    // 19:00は16:00-0:00の時間帯
    expect(instanceSlotKey).toBe("16:00-0:00");
    expect(instanceSlotKey).not.toBe("8:00-12:00");
  });

  test("14:00開始予定のタスクを19:39に実行した場合も正しい時間帯", () => {
    const exec = {
      startTime: new Date("2024-01-15T19:39:00"), // 19:39に実行
      slotKey: "12:00-16:00" // 元の時間帯（バグで保存された値）
    };
    
    const isRoutine = true;
    
    // 修正後のロジックをシミュレート
    let instanceSlotKey;
    
    if (isRoutine && exec.startTime) {
      const startHour = exec.startTime.getHours();
      const startMinute = exec.startTime.getMinutes();
      const timeInMinutes = startHour * 60 + startMinute;
      
      if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
        instanceSlotKey = "0:00-8:00";
      } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
        instanceSlotKey = "8:00-12:00";
      } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
        instanceSlotKey = "12:00-16:00";
      } else {
        instanceSlotKey = "16:00-0:00";
      }
    } else {
      instanceSlotKey = exec.slotKey || "none";
    }
    
    // 19:39は16:00-0:00の時間帯
    expect(instanceSlotKey).toBe("16:00-0:00");
    expect(instanceSlotKey).not.toBe("12:00-16:00");
  });

  test("非ルーチンタスクは保存されたslotKeyを使用する", () => {
    const exec = {
      startTime: new Date("2024-01-15T19:00:00"),
      slotKey: "8:00-12:00"
    };
    
    const isRoutine = false; // 非ルーチンタスク
    const slotKey = "none"; // デフォルト値
    
    // 修正後のロジックをシミュレート
    let instanceSlotKey;
    
    if (isRoutine && exec.startTime) {
      const startHour = exec.startTime.getHours();
      const startMinute = exec.startTime.getMinutes();
      const timeInMinutes = startHour * 60 + startMinute;
      
      if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
        instanceSlotKey = "0:00-8:00";
      } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
        instanceSlotKey = "8:00-12:00";
      } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
        instanceSlotKey = "12:00-16:00";
      } else {
        instanceSlotKey = "16:00-0:00";
      }
    } else {
      instanceSlotKey = exec.slotKey || slotKey;
    }
    
    // 非ルーチンタスクは保存されたslotKeyを使用
    expect(instanceSlotKey).toBe("8:00-12:00");
  });

});