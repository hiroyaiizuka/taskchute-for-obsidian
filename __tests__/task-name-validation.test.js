const { TaskChuteView, TaskChutePlugin } = require('../main.js')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')
require('../__mocks__/obsidian')

describe('TaskNameValidator', () => {
  let view
  let plugin
  let app

  beforeEach(() => {
    app = global.app
    plugin = new TaskChutePlugin()
    plugin.app = app
    
    const mockLeaf = {
      view: {},
      getViewState: () => ({}),
      setViewState: jest.fn(),
    }
    
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = app
    view.plugin = plugin
    
    // jsdomはDOM APIを提供しているので、特別なモックは不要
    
    // setTimeoutのモック
    jest.useFakeTimers()
  })
  
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  describe('validate method', () => {
    test('禁止文字を正しく検出する', () => {
      const result = view.TaskNameValidator.validate('task:name')
      expect(result.isValid).toBe(false)
      expect(result.invalidChars).toContain(':')
    })

    test('複数の禁止文字を検出する', () => {
      const result = view.TaskNameValidator.validate('task:name|with/slash')
      expect(result.isValid).toBe(false)
      expect(result.invalidChars).toContain(':')
      expect(result.invalidChars).toContain('|')
      expect(result.invalidChars).toContain('/')
    })

    test('バックスラッシュを検出する', () => {
      const result = view.TaskNameValidator.validate('task\\name')
      expect(result.isValid).toBe(false)
      expect(result.invalidChars).toContain('\\')
    })

    test('ハッシュ記号を検出する', () => {
      const result = view.TaskNameValidator.validate('task#name')
      expect(result.isValid).toBe(false)
      expect(result.invalidChars).toContain('#')
    })

    test('キャレット記号を検出する', () => {
      const result = view.TaskNameValidator.validate('task^name')
      expect(result.isValid).toBe(false)
      expect(result.invalidChars).toContain('^')
    })

    test('有効なタスク名を受け入れる', () => {
      const result = view.TaskNameValidator.validate('valid-task-name')
      expect(result.isValid).toBe(true)
      expect(result.invalidChars).toEqual([])
    })

    test('日本語を含むタスク名を受け入れる', () => {
      const result = view.TaskNameValidator.validate('タスク名_テスト')
      expect(result.isValid).toBe(true)
      expect(result.invalidChars).toEqual([])
    })

    test('空文字列を有効として扱う', () => {
      const result = view.TaskNameValidator.validate('')
      expect(result.isValid).toBe(true)
      expect(result.invalidChars).toEqual([])
    })

    test('重複した禁止文字をユニークにする', () => {
      const result = view.TaskNameValidator.validate('task:::name')
      expect(result.isValid).toBe(false)
      expect(result.invalidChars).toEqual([':'])
      expect(result.invalidChars.length).toBe(1)
    })
  })

  describe('getErrorMessage method', () => {
    test('単一の禁止文字のエラーメッセージ', () => {
      const message = view.TaskNameValidator.getErrorMessage([':'])
      expect(message).toBe('使用できない文字が含まれています: :')
    })

    test('複数の禁止文字のエラーメッセージ', () => {
      const message = view.TaskNameValidator.getErrorMessage([':', '|', '/'])
      expect(message).toBe('使用できない文字が含まれています: :, |, /')
    })

    test('空配列の場合のエラーメッセージ', () => {
      const message = view.TaskNameValidator.getErrorMessage([])
      expect(message).toBe('使用できない文字が含まれています: ')
    })
  })

  describe('モーダル入力検証', () => {
    let modal
    let nameInput
    let createButton
    let warningMessage

    beforeEach(() => {
      // モーダル要素のモック作成
      document.body.innerHTML = ''
      modal = document.createElement('div')
      document.body.appendChild(modal)
      
      const form = document.createElement('form')
      modal.appendChild(form)
      
      const nameGroup = document.createElement('div')
      form.appendChild(nameGroup)
      
      nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.className = 'form-input'
      // classListのモックを追加
      nameInput.classList = {
        add: jest.fn((className) => {
          if (!nameInput.className.includes(className)) {
            nameInput.className += ' ' + className
          }
        }),
        remove: jest.fn((className) => {
          nameInput.className = nameInput.className.replace(new RegExp('\\b' + className + '\\b', 'g'), '').trim()
        }),
        contains: jest.fn((className) => {
          return nameInput.className.includes(className)
        })
      }
      nameGroup.appendChild(nameInput)
      
      warningMessage = document.createElement('div')
      warningMessage.className = 'task-name-warning hidden'
      // classListのモックを追加
      warningMessage.classList = {
        add: jest.fn((className) => {
          if (!warningMessage.className.includes(className)) {
            warningMessage.className += ' ' + className
          }
        }),
        remove: jest.fn((className) => {
          warningMessage.className = warningMessage.className.replace(new RegExp('\\b' + className + '\\b', 'g'), '').trim()
        }),
        contains: jest.fn((className) => {
          return warningMessage.className.includes(className)
        })
      }
      nameGroup.appendChild(warningMessage)
      
      createButton = document.createElement('button')
      createButton.type = 'submit'
      createButton.className = 'form-button create'
      // classListのモックを追加
      createButton.classList = {
        add: jest.fn((className) => {
          if (!createButton.className.includes(className)) {
            createButton.className += ' ' + className
          }
        }),
        remove: jest.fn((className) => {
          createButton.className = createButton.className.replace(new RegExp('\\b' + className + '\\b', 'g'), '').trim()
        }),
        contains: jest.fn((className) => {
          return createButton.className.includes(className)
        })
      }
      form.appendChild(createButton)
    })

    afterEach(() => {
      document.body.innerHTML = ''
    })

    test('setupTaskNameValidation が正しく初期化される', () => {
      // setupTaskNameValidationメソッドが存在することを確認
      expect(typeof view.setupTaskNameValidation).toBe('function')
      
      view.setupTaskNameValidation(nameInput, createButton, warningMessage)
      
      // 初期状態では有効
      expect(createButton.disabled).toBe(false)
      expect(warningMessage.classList.contains('hidden')).toBe(true)
      expect(nameInput.classList.contains('error')).toBe(false)
    })

    test('禁止文字入力時にUIが更新される', () => {
      // setupTaskNameValidationが正しく呼び出せるか確認
      expect(() => view.setupTaskNameValidation(nameInput, createButton, warningMessage)).not.toThrow()
      
      // 初期状態の確認
      expect(createButton.disabled).toBe(false)
      
      // 入力イベントリスナーが追加されているか確認
      const inputListeners = nameInput.addEventListener.mock.calls.filter(call => call[0] === 'input')
      expect(inputListeners.length).toBeGreaterThan(0)
      
      // イベントリスナーを直接呼び出してテスト
      nameInput.value = 'task:name'
      const validation = view.TaskNameValidator.validate(nameInput.value)
      view.updateValidationUI(nameInput, createButton, warningMessage, validation)
      
      // 結果の確認
      expect(createButton.disabled).toBe(true)
      expect(warningMessage.classList.contains('hidden')).toBe(false)
      expect(warningMessage.textContent).toBe('使用できない文字が含まれています: :')
      expect(nameInput.classList.contains('error')).toBe(true)
    })

    test('禁止文字削除時にUIが正常状態に戻る', () => {
      view.setupTaskNameValidation(nameInput, createButton, warningMessage)
      
      // まず禁止文字を入力
      nameInput.value = 'task:name'
      let validation = view.TaskNameValidator.validate(nameInput.value)
      view.updateValidationUI(nameInput, createButton, warningMessage, validation)
      
      // エラー状態の確認
      expect(createButton.disabled).toBe(true)
      
      // 禁止文字を削除
      nameInput.value = 'taskname'
      validation = view.TaskNameValidator.validate(nameInput.value)
      view.updateValidationUI(nameInput, createButton, warningMessage, validation)
      
      // 正常状態に戻ったことを確認
      expect(createButton.disabled).toBe(false)
      expect(warningMessage.classList.contains('hidden')).toBe(true)
      expect(nameInput.classList.contains('error')).toBe(false)
    })

    test('validateTaskNameBeforeSubmit が正しく動作する', () => {
      nameInput.value = 'valid-name'
      expect(view.validateTaskNameBeforeSubmit(nameInput)).toBe(true)
      
      nameInput.value = 'invalid:name'
      expect(view.validateTaskNameBeforeSubmit(nameInput)).toBe(false)
    })

    test('highlightWarning が警告を強調表示する', () => {
      // highlightWarningメソッドが存在することを確認
      expect(typeof view.highlightWarning).toBe('function')
      
      // メソッドを呼び出し
      view.highlightWarning(warningMessage)
      
      // highlightクラスが追加されたことを確認
      expect(warningMessage.classList.add).toHaveBeenCalledWith('highlight')
      
      // タイマーが1つ設定されたことを確認
      expect(jest.getTimerCount()).toBe(1)
      
      // タイマーを進める
      jest.advanceTimersByTime(300)
      
      // highlightクラスが削除されたことを確認
      expect(warningMessage.classList.remove).toHaveBeenCalledWith('highlight')
    })
  })
})