// グローバルなモック設定
global.console = {
  ...console,
  // テスト中のコンソールログを抑制（必要に応じて）
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}

// localStorage のモック
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}
global.localStorage = localStorageMock

// DOM 要素のモック
const createMockElement = (tag = 'div') => {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    type: "",
    id: "",
    className: "",
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(),
    },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    appendChild: jest.fn(function(child) {
      this.children.push(child)
      if (child.parentNode !== this) {
        child.parentNode = this
      }
      return child
    }),
    removeChild: jest.fn(function(child) {
      const index = this.children.indexOf(child)
      if (index > -1) {
        this.children.splice(index, 1)
      }
      return child
    }),
    querySelector: jest.fn(function(selector) {
      if (selector.startsWith('.')) {
        const className = selector.slice(1)
        const findInChildren = (el) => {
          if (el.className && el.className.includes(className)) return el
          for (const child of el.children || []) {
            const found = findInChildren(child)
            if (found) return found
          }
          return null
        }
        return findInChildren(this)
      }
      if (selector.startsWith('input[value="')) {
        const value = selector.match(/value="([^"]+)"/)?.[1]
        const findInput = (el) => {
          if (el.tagName === 'INPUT' && el.value === value) return el
          for (const child of el.children || []) {
            const found = findInput(child)
            if (found) return found
          }
          return null
        }
        return findInput(this)
      }
      return null
    }),
    querySelectorAll: jest.fn(function(selector) {
      const results = []
      if (selector === '.weekday-checkbox') {
        const findCheckboxes = (el) => {
          if (el.className && el.className.includes('weekday-checkbox')) {
            results.push(el)
          }
          for (const child of el.children || []) {
            findCheckboxes(child)
          }
        }
        findCheckboxes(this)
      }
      if (selector === 'button') {
        const findButtons = (el) => {
          if (el.tagName === 'BUTTON') {
            results.push(el)
          }
          for (const child of el.children || []) {
            findButtons(child)
          }
        }
        findButtons(this)
      }
      return results
    }),
    click: jest.fn(function() {
      if (this.type === 'checkbox') {
        this.checked = !this.checked
      }
      const changeEvent = new Event('change')
      this.dispatchEvent(changeEvent)
    }),
    dispatchEvent: jest.fn(function(event) {
      const listeners = this.addEventListener.mock.calls.filter(call => call[0] === event.type)
      listeners.forEach(([, handler]) => handler(event))
    }),
    createEl: jest.fn(function(tag, options = {}) {
      const el = createMockElement(tag)
      if (options.cls) el.className = options.cls
      if (options.text) el.textContent = options.text
      if (options.value) el.value = options.value
      if (options.type) el.type = options.type
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          el[key] = value
        })
      }
      this.appendChild(el)
      return el
    }),
    createSpan: jest.fn(function(options = {}) {
      const span = createMockElement('span')
      if (options.text) span.textContent = options.text
      this.appendChild(span)
      return span
    }),
    empty: jest.fn(function() {
      this.children = []
      this.innerHTML = ''
    }),
    setText: jest.fn(function(text) {
      this.textContent = text
    }),
    focus: jest.fn(),
    parentNode: null
  }
  
  // EventインターフェースのようなbeforeEachを追加
  element.addEventListener.mockImplementation(function(event, handler) {
    if (!element._eventListeners) {
      element._eventListeners = {}
    }
    if (!element._eventListeners[event]) {
      element._eventListeners[event] = []
    }
    element._eventListeners[event].push(handler)
  })
  
  element.dispatchEvent.mockImplementation(function(event) {
    if (element._eventListeners && element._eventListeners[event.type]) {
      element._eventListeners[event.type].forEach(handler => handler(event))
    }
  })
  
  return element
}

global.document = global.document || {}
global.document.createElement = jest.fn((tag) => {
  const element = createMockElement(tag)
  // showRoutineEditModalで使用されるメソッドを追加
  if (!element.createEl) {
    element.createEl = element.createEl
  }
  if (!element.createSpan) {
    element.createSpan = element.createSpan
  }
  return element
})
if (!global.document.body) {
  global.document.body = createMockElement('body')
}
global.document.body.innerHTML = ''
global.document.querySelector = jest.fn((selector) => {
  if (selector === '.task-modal-overlay') {
    return global.document.body.querySelector(selector)
  }
  return null
})
global.document.querySelectorAll = jest.fn((selector) => {
  return global.document.body.querySelectorAll(selector)
})
if (!global.document.head) {
  global.document.head = {}
}
global.document.head.appendChild = jest.fn()

// タイマーのモック
global.setInterval = jest.fn()
global.clearInterval = jest.fn()
global.setTimeout = jest.fn()
global.clearTimeout = jest.fn()

// ResizeObserver のモック
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}))

// Obsidian API のグローバルモック
global.Notice = jest.fn()
global.moment = require("moment")
