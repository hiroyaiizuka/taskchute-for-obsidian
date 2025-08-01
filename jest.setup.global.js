// グローバルなテスト設定の改善版

// console出力の制御（必要に応じて）
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}

// localStorage のモック
const localStorageMock = {
  getItem: jest.fn(() => null),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}
global.localStorage = localStorageMock

// ResizeObserver のモック
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}))

// Obsidian API のグローバルモック
global.Notice = jest.fn()
global.moment = require("moment")

// 基本的なDOM要素生成関数
function createBasicElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
    },
    style: {},
    children: [],
    appendChild: jest.fn(function(child) {
      this.children.push(child)
      return child
    }),
    removeChild: jest.fn(function(child) {
      const index = this.children.indexOf(child)
      if (index > -1) {
        this.children.splice(index, 1)
      }
      return child
    }),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(() => null),
    querySelector: jest.fn(() => null),
    querySelectorAll: jest.fn(() => []),
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    focus: jest.fn(),
    click: jest.fn(),
    parentNode: null,
    offsetHeight: 0,
    offsetWidth: 0,
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect: jest.fn(() => ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    })),
  }
}

// document の基本的なモック
global.document = {
  createElement: jest.fn((tag) => createBasicElement(tag)),
  body: createBasicElement('body'),
  head: createBasicElement('head'),
  querySelector: jest.fn(() => null),
  querySelectorAll: jest.fn(() => []),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}

// window の基本的なモック
global.window = {
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  requestAnimationFrame: jest.fn((cb) => setTimeout(cb, 0)),
  cancelAnimationFrame: jest.fn((id) => clearTimeout(id)),
}

// Event クラスのモック
global.Event = jest.fn((type, options) => ({
  type,
  preventDefault: jest.fn(),
  stopPropagation: jest.fn(),
  target: null,
  currentTarget: null,
  ...options,
}))

// KeyboardEvent クラスのモック
global.KeyboardEvent = jest.fn((type, options) => ({
  type,
  key: options?.key || '',
  code: options?.code || '',
  ctrlKey: options?.ctrlKey || false,
  shiftKey: options?.shiftKey || false,
  altKey: options?.altKey || false,
  metaKey: options?.metaKey || false,
  preventDefault: jest.fn(),
  stopPropagation: jest.fn(),
  target: null,
  currentTarget: null,
}))

// タイマーのモック
global.setInterval = jest.fn()
global.clearInterval = jest.fn()
global.setTimeout = jest.fn((cb) => cb())
global.clearTimeout = jest.fn()