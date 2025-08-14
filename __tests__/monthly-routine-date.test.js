const { TaskChuteView } = require('../main.js')
const { Notice } = require('obsidian')

describe('月次ルーチン日付計算', () => {
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

  describe('getNthWeekdayOfMonth', () => {
    describe('第N週の計算', () => {
      test('2024年1月の第1月曜日は1月1日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 1)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(1)
      })

      test('2024年1月の第2月曜日は1月8日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 2)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(8)
      })

      test('2024年1月の第3月曜日は1月15日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 3)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(15)
      })

      test('2024年1月の第4月曜日は1月22日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 4)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(22)
      })

      test('2024年1月の第5月曜日は1月29日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 5)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(29)
      })
    })

    describe('最終週の計算', () => {
      test('2024年1月の最終月曜日は1月29日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 'last')
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(29)
      })

      test('2024年2月の最終木曜日は2月29日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 1, 4, 'last')
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(29)
      })

      test('2024年3月の最終日曜日は3月31日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 2, 0, 'last')
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(31)
      })
    })

    describe('存在しない第N週の処理', () => {
      test('2024年2月の第5月曜日は存在しない', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 1, 1, 5)
        expect(result).toBeNull()
      })

      test('2024年4月の第5火曜日は4月30日', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 3, 2, 5)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(30)
      })
      
      test('2024年4月の第5水曜日は存在しない', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 3, 3, 5)
        expect(result).toBeNull()
      })

      test('2023年2月の第5金曜日は存在しない', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2023, 1, 5, 5)
        expect(result).toBeNull()
      })
    })

    describe('エッジケース', () => {
      test('月初が該当曜日の場合', () => {
        // 2024年1月1日は月曜日
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 1, 1)
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(1)
      })

      test('月末が該当曜日の場合', () => {
        // 2024年3月31日は日曜日
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 2, 0, 'last')
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(31)
      })

      test('うるう年の2月29日', () => {
        // 2024年2月29日は木曜日
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 1, 4, 'last')
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(29)
      })

      test('通常年の2月最終日', () => {
        // 2023年2月28日は火曜日
        const result = taskChuteView.getNthWeekdayOfMonth(2023, 1, 2, 'last')
        expect(result).not.toBeNull()
        expect(result.getDate()).toBe(28)
      })
    })

    describe('各曜日のテスト', () => {
      test('日曜日（0）の計算', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 0, 2)
        expect(result).not.toBeNull()
        expect(result.getDay()).toBe(0)
        expect(result.getDate()).toBe(14)
      })

      test('土曜日（6）の計算', () => {
        const result = taskChuteView.getNthWeekdayOfMonth(2024, 0, 6, 2)
        expect(result).not.toBeNull()
        expect(result.getDay()).toBe(6)
        expect(result.getDate()).toBe(13)
      })
    })
  })
})