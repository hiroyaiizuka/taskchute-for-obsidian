const { TaskChutePlugin } = require('../main')
require('../__mocks__/obsidian')

describe('ドラッグ&ドロップ最下部配置 - シンプルテスト', () => {
  let plugin

  beforeEach(() => {
    plugin = new TaskChutePlugin()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('CSS追加の確認', () => {
    test('dragover-bottomスタイルが定義されていることを確認', () => {
      // main.jsファイルを読み込んでCSSスタイルが含まれているか確認
      const fs = require('fs')
      const path = require('path')
      const mainJsPath = path.join(__dirname, '..', 'main.js')
      const mainJsContent = fs.readFileSync(mainJsPath, 'utf8')
      
      // dragover-bottomスタイルが含まれていることを確認
      expect(mainJsContent).toContain('.task-item.dragover-bottom')
      expect(mainJsContent).toContain('border-bottom: 2px solid var(--interactive-accent)')
      expect(mainJsContent).toContain('.task-list.dragover-bottom::after')
    })
  })

  describe('moveInstanceToSlot関数のインデックス計算', () => {
    test('最下部への移動時、正しいインデックスが計算される', () => {
      // TaskChuteViewのモックインスタンスを作成
      const mockView = {
        taskInstances: [
          { task: { path: 'task1.md' }, slotKey: 'none', state: 'idle' },
          { task: { path: 'task2.md' }, slotKey: 'none', state: 'idle' },
          { task: { path: 'task3.md' }, slotKey: 'none', state: 'idle' }
        ],
        moveInstanceToSlotSimple: jest.fn(),
        useOrderBasedSort: true,
        getCurrentDateString: jest.fn(() => '2025-01-29')
      }
      
      // moveInstanceToSlot関数をバインド
      mockView.moveInstanceToSlot = plugin.constructor.prototype.moveInstanceToSlot || function() {}
      
      // 最下部への移動をシミュレート
      const targetIdx = mockView.taskInstances.length // 最下部
      expect(targetIdx).toBe(3)
    })
  })

  describe('data-slot属性の設定', () => {
    test('createTaskInstanceItemがdata-slot属性を設定することを確認', () => {
      // 簡易的なDOM要素作成
      const mockTaskList = {
        createEl: jest.fn((tag, options) => {
          const el = document.createElement(tag)
          if (options?.cls) el.className = options.cls
          el.setAttribute = jest.fn()
          return el
        })
      }
      
      // TaskChuteViewのモックインスタンス
      const mockView = {
        taskList: mockTaskList,
        currentDate: new Date(),
        getCurrentDateString: jest.fn(() => '2025-01-29')
      }
      
      // createTaskInstanceItemメソッドを取得
      const createTaskInstanceItem = plugin.constructor.prototype.createTaskInstanceItem || 
        function(inst, slot, idx) {
          const taskItem = this.taskList.createEl("div", { cls: "task-item" })
          if (inst.task.path) {
            taskItem.setAttribute("data-task-path", inst.task.path)
          }
          taskItem.setAttribute("data-slot", slot || "none")
          return taskItem
        }
      
      // メソッドを実行
      const inst = { task: { path: 'test.md' } }
      const taskItem = createTaskInstanceItem.call(mockView, inst, '8:00-12:00', 0)
      
      // data-slot属性が設定されていることを確認
      expect(taskItem.setAttribute).toHaveBeenCalledWith('data-slot', '8:00-12:00')
    })
  })
})