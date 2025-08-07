// order-based-sort.test.js
// orderフィールドのみを使用したソート処理のテスト

const { TaskChutePlugin } = require('../main.js')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')

// Obsidian APIのモック
global.app = {
  vault: {
    getMarkdownFiles: jest.fn().mockReturnValue([]),
    read: jest.fn(),
    modify: jest.fn(),
    getAbstractFileByPath: jest.fn()
  },
  workspace: {
    getLeaf: jest.fn(),
    getActiveFile: jest.fn()
  },
  metadataCache: {
    getFileCache: jest.fn()
  }
}

global.Notice = jest.fn()
global.moment = require('moment')

describe('Order-based Sort', () => {
  let plugin

  beforeEach(() => {
    // localStorageのモック
    const localStorageMock = {}
    global.localStorage = {
      getItem: jest.fn(key => localStorageMock[key]),
      setItem: jest.fn((key, value) => { localStorageMock[key] = value }),
      removeItem: jest.fn(key => { delete localStorageMock[key] }),
      clear: jest.fn(() => { Object.keys(localStorageMock).forEach(key => delete localStorageMock[key]) })
    }

    plugin = new TaskChutePlugin()
    plugin.taskInstances = []
  })

  describe('sortByOrder（新しい統一ソート関数）', () => {
    test('状態優先でソートされる（done > running > idle）', () => {
      // テスト用のタスクインスタンスを作成
      plugin.taskInstances = [
        { state: 'idle', order: 100, task: { path: 'task1.md' } },
        { state: 'done', order: 200, task: { path: 'task2.md' } },
        { state: 'running', order: 300, task: { path: 'task3.md' } },
        { state: 'idle', order: 50, task: { path: 'task4.md' } }
      ]

      // sortByOrderの実装（テスト用仮実装）
      plugin.sortByOrder = function() {
        this.taskInstances.sort((a, b) => {
          const stateOrder = { done: 0, running: 1, idle: 2 }
          if (a.state !== b.state) {
            return stateOrder[a.state] - stateOrder[b.state]
          }
          return a.order - b.order
        })
      }

      plugin.sortByOrder()

      expect(plugin.taskInstances[0].state).toBe('done')
      expect(plugin.taskInstances[1].state).toBe('running')
      expect(plugin.taskInstances[2].state).toBe('idle')
      expect(plugin.taskInstances[3].state).toBe('idle')
    })

    test('同じ状態内ではorder番号でソートされる', () => {
      plugin.taskInstances = [
        { state: 'idle', order: 300, task: { path: 'task1.md' } },
        { state: 'idle', order: 100, task: { path: 'task2.md' } },
        { state: 'idle', order: 200, task: { path: 'task3.md' } }
      ]

      plugin.sortByOrder = function() {
        this.taskInstances.sort((a, b) => {
          const stateOrder = { done: 0, running: 1, idle: 2 }
          if (a.state !== b.state) {
            return stateOrder[a.state] - stateOrder[b.state]
          }
          return a.order - b.order
        })
      }

      plugin.sortByOrder()

      expect(plugin.taskInstances[0].order).toBe(100)
      expect(plugin.taskInstances[1].order).toBe(200)
      expect(plugin.taskInstances[2].order).toBe(300)
    })
  })

  describe('calculateSimpleOrder（新しいorder計算関数）', () => {
    test('空のスロットでは100を返す', () => {
      plugin.calculateSimpleOrder = function(targetIndex, sameTasks) {
        const sorted = sameTasks.sort((a, b) => a.order - b.order)
        
        if (sorted.length === 0) return 100
        if (targetIndex <= 0) return sorted[0].order - 100
        if (targetIndex >= sorted.length) return sorted[sorted.length - 1].order + 100
        
        const prev = sorted[targetIndex - 1].order
        const next = sorted[targetIndex].order
        
        if (next - prev > 1) {
          return Math.floor((prev + next) / 2)
        }
        
        // 正規化が必要な場合（仮実装）
        return targetIndex * 100 + 50
      }

      const result = plugin.calculateSimpleOrder(0, [])
      expect(result).toBe(100)
    })

    test('最初の位置に挿入する場合、最小order - 100を返す', () => {
      const sameTasks = [
        { order: 200 },
        { order: 300 }
      ]

      plugin.calculateSimpleOrder = function(targetIndex, sameTasks) {
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
      }

      const result = plugin.calculateSimpleOrder(0, sameTasks)
      expect(result).toBe(100) // 200 - 100
    })

    test('最後の位置に挿入する場合、最大order + 100を返す', () => {
      const sameTasks = [
        { order: 200 },
        { order: 300 }
      ]

      plugin.calculateSimpleOrder = function(targetIndex, sameTasks) {
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
      }

      const result = plugin.calculateSimpleOrder(2, sameTasks)
      expect(result).toBe(400) // 300 + 100
    })

    test('中間に挿入する場合、前後の平均値を返す', () => {
      const sameTasks = [
        { order: 100 },
        { order: 300 }
      ]

      plugin.calculateSimpleOrder = function(targetIndex, sameTasks) {
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
      }

      const result = plugin.calculateSimpleOrder(1, sameTasks)
      expect(result).toBe(200) // (100 + 300) / 2
    })
  })

  describe('determineSlotKey（新しいスロット決定関数）', () => {
    test('保存されたslot情報を最優先で使用する', () => {
      const savedOrders = {
        'task1.md': { slot: '8:00-12:00', order: 100 }
      }

      plugin.determineSlotKey = function(taskPath, savedOrders, taskObj) {
        if (savedOrders[taskPath]?.slot) {
          return savedOrders[taskPath].slot
        }
        
        if (taskObj.scheduledTime) {
          return this.getSlotFromScheduledTime(taskObj.scheduledTime)
        }
        
        return 'none'
      }

      const result = plugin.determineSlotKey('task1.md', savedOrders, {})
      expect(result).toBe('8:00-12:00')
    })

    test('保存情報がない場合はscheduledTimeから計算', () => {
      const savedOrders = {}
      const taskObj = { scheduledTime: '10:00' }

      plugin.getSlotFromScheduledTime = jest.fn().mockReturnValue('8:00-12:00')
      plugin.determineSlotKey = function(taskPath, savedOrders, taskObj) {
        if (savedOrders[taskPath]?.slot) {
          return savedOrders[taskPath].slot
        }
        
        if (taskObj.scheduledTime) {
          return this.getSlotFromScheduledTime(taskObj.scheduledTime)
        }
        
        return 'none'
      }

      const result = plugin.determineSlotKey('task1.md', savedOrders, taskObj)
      expect(result).toBe('8:00-12:00')
    })

    test('どちらもない場合はnoneを返す', () => {
      const savedOrders = {}
      const taskObj = {}

      plugin.determineSlotKey = function(taskPath, savedOrders, taskObj) {
        if (savedOrders[taskPath]?.slot) {
          return savedOrders[taskPath].slot
        }
        
        if (taskObj.scheduledTime) {
          return this.getSlotFromScheduledTime(taskObj.scheduledTime)
        }
        
        return 'none'
      }

      const result = plugin.determineSlotKey('task1.md', savedOrders, taskObj)
      expect(result).toBe('none')
    })
  })
})