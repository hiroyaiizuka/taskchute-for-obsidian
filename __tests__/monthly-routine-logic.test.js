const { TaskChuteView } = require('../main.js')
const { Notice } = require('obsidian')

describe('月次ルーチンビジネスロジック', () => {
  let taskChuteView
  let plugin

  beforeEach(() => {
    plugin = {
      settings: {},
      fileManager: {
        updateFileMetadata: jest.fn(),
      },
    }
    taskChuteView = new TaskChuteView(null, plugin)
  })

  describe('shouldShowWeeklyRoutine - 月次ルーチン判定', () => {
    test('月次ルーチン: 毎月第1月曜日 - 該当日にtrue', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 1,
        monthlyWeekday: 1 // 月曜日
      }
      // 2024年1月1日は月曜日（第1月曜日）
      const date = new Date(2024, 0, 1)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })

    test('月次ルーチン: 毎月第1月曜日 - 非該当日にfalse', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 1,
        monthlyWeekday: 1 // 月曜日
      }
      // 2024年1月2日は火曜日（第1月曜日ではない）
      const date = new Date(2024, 0, 2)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false)
    })

    test('月次ルーチン: 毎月第2木曜日 - 該当日にtrue', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 2,
        monthlyWeekday: 4 // 木曜日
      }
      // 2024年1月11日は木曜日（第2木曜日）
      const date = new Date(2024, 0, 11)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })

    test('月次ルーチン: 毎月最終金曜日 - 該当日にtrue', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 'last',
        monthlyWeekday: 5 // 金曜日
      }
      // 2024年1月26日は金曜日（最終金曜日）
      const date = new Date(2024, 0, 26)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })

    test('月次ルーチン: 毎月最終金曜日 - 非該当日にfalse', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 'last',
        monthlyWeekday: 5 // 金曜日
      }
      // 2024年1月19日は金曜日だが最終金曜日ではない
      const date = new Date(2024, 0, 19)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false)
    })

    test('月次ルーチン: 存在しない第5週 - false', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 5,
        monthlyWeekday: 1 // 月曜日
      }
      // 2024年2月には第5月曜日は存在しない
      const date = new Date(2024, 1, 26) // 2月26日月曜日（第4月曜日）
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false)
    })

    test('月次ルーチン: monthlyWeekdayが未定義の場合 - false', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 1,
        monthlyWeekday: undefined
      }
      const date = new Date(2024, 0, 1)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false)
    })

    test('月次ルーチン: monthlyWeekが未定義の場合 - false', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: undefined,
        monthlyWeekday: 1
      }
      const date = new Date(2024, 0, 1)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false)
    })
  })

  describe('既存ルーチンタイプとの共存', () => {
    test('daily ルーチンは影響を受けない', () => {
      const task = {
        routineType: 'daily'
      }
      const date = new Date(2024, 0, 1)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false) // dailyタイプはこのメソッドの対象外
    })

    test('weekly ルーチンは影響を受けない', () => {
      const task = {
        routineType: 'weekly',
        weekday: 1 // 月曜日
      }
      const date = new Date(2024, 0, 1) // 月曜日
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })

    test('custom ルーチンは影響を受けない', () => {
      const task = {
        routineType: 'custom',
        weekdays: [1, 3, 5] // 月・水・金
      }
      const date = new Date(2024, 0, 1) // 月曜日
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })
  })

  describe('月次ルーチンのエッジケース', () => {
    test('うるう年の2月29日の処理', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 'last',
        monthlyWeekday: 4 // 木曜日
      }
      // 2024年2月29日は木曜日（うるう年）
      const date = new Date(2024, 1, 29)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })

    test('通常年の2月28日の処理', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 'last',
        monthlyWeekday: 3 // 水曜日
      }
      // 2023年2月28日は火曜日なので該当しない
      const date = new Date(2023, 1, 28)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(false)
    })

    test('月初が該当曜日の場合', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 1,
        monthlyWeekday: 1 // 月曜日
      }
      // 2024年1月1日は月曜日（月初が第1月曜日）
      const date = new Date(2024, 0, 1)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })

    test('月末が該当曜日の場合', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 'last',
        monthlyWeekday: 0 // 日曜日
      }
      // 2024年3月31日は日曜日（月末が最終日曜日）
      const date = new Date(2024, 2, 31)
      const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
      expect(result).toBe(true)
    })
  })

  describe('異なる月での月次ルーチンテスト', () => {
    test('2024年各月の第2火曜日', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 2,
        monthlyWeekday: 2 // 火曜日
      }
      
      // 各月の第2火曜日の日付
      const secondTuesdays = [
        new Date(2024, 0, 9),   // 1月9日
        new Date(2024, 1, 13),  // 2月13日
        new Date(2024, 2, 12),  // 3月12日
        new Date(2024, 3, 9),   // 4月9日
        new Date(2024, 4, 14),  // 5月14日
        new Date(2024, 5, 11),  // 6月11日
      ]
      
      secondTuesdays.forEach(date => {
        const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
        expect(result).toBe(true)
      })
    })

    test('2024年各月の最終金曜日', () => {
      const task = {
        routineType: 'monthly',
        monthlyWeek: 'last',
        monthlyWeekday: 5 // 金曜日
      }
      
      // 各月の最終金曜日の日付
      const lastFridays = [
        new Date(2024, 0, 26),  // 1月26日
        new Date(2024, 1, 23),  // 2月23日
        new Date(2024, 2, 29),  // 3月29日
        new Date(2024, 3, 26),  // 4月26日
        new Date(2024, 4, 31),  // 5月31日
        new Date(2024, 5, 28),  // 6月28日
      ]
      
      lastFridays.forEach(date => {
        const result = taskChuteView.shouldShowWeeklyRoutine(task, date)
        expect(result).toBe(true)
      })
    })
  })
})