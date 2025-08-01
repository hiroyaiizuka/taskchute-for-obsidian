// Obsidian API のモック
const Plugin = jest.fn().mockImplementation(() => ({
  onload: jest.fn(),
  onunload: jest.fn(),
  addRibbonIcon: jest.fn(),
  addCommand: jest.fn(),
  addSettingTab: jest.fn(),
  registerView: jest.fn(),
  loadData: jest.fn(),
  saveData: jest.fn(),
}))

const ItemView = function () {
  this.getViewType = jest.fn()
  this.getDisplayText = jest.fn()
  this.onOpen = jest.fn()
  this.onClose = jest.fn()
  this.registerEvent = jest.fn()
}

const WorkspaceLeaf = jest.fn().mockImplementation(() => ({
  setViewState: jest.fn(),
  getViewState: jest.fn(),
}))

const TFile = jest.fn().mockImplementation(() => ({
  path: "test-file.md",
  basename: "test-file",
  extension: "md",
}))

const Notice = jest.fn()

const PluginSettingTab = jest.fn().mockImplementation(() => ({
  display: jest.fn(),
}))

const Setting = jest.fn().mockImplementation(() => {
  const settingInstance = {
    setName: jest.fn().mockReturnThis(),
    setDesc: jest.fn().mockReturnThis(),
    addToggle: jest.fn().mockReturnThis(),
    addText: jest.fn().mockReturnThis(),
    addTextArea: jest.fn().mockReturnThis(),
    addButton: jest.fn().mockReturnThis(),
    addDropdown: jest.fn().mockReturnThis(),
    addSlider: jest.fn().mockReturnThis(),
  }
  return settingInstance
})

// DOM要素のモック関数
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
      // 簡単なセレクタ実装
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
  }
  return element
}

const mockLeaf = {
  containerEl: {
    children: [
      {},
      createMockElement(),
    ],
  },
}

const mockApp = {
  vault: {
    getMarkdownFiles: jest.fn().mockReturnValue([]),
    read: jest.fn().mockResolvedValue(""),
    create: jest.fn().mockResolvedValue(null),
    modify: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(null),
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    on: jest.fn().mockReturnValue({ unload: jest.fn() }),
    adapter: {
      getFullPath: jest.fn().mockReturnValue(""),
      exists: jest.fn().mockResolvedValue(false),
      read: jest.fn().mockResolvedValue(""),
      write: jest.fn().mockResolvedValue(),
      mkdir: jest.fn().mockResolvedValue(),
    },
  },
  workspace: {
    openLinkText: jest.fn(),
    getLeavesOfType: jest.fn().mockReturnValue([]),
    onLayoutReady: jest.fn((cb) => cb()),
  },
  metadataCache: {
    getFileCache: jest.fn().mockReturnValue({ frontmatter: {} }),
  },
  fileManager: {
    processFrontMatter: jest.fn((file, cb) => {
      const frontmatter = {} // 空のfrontmatterで開始
      const newFrontmatter = cb(frontmatter)
      return Promise.resolve(newFrontmatter)
    }),
  },
  plugins: {
    plugins: {
      "taskchute-plus": {
        settings: {
          enableCelebration: true,
          enableSound: true,
          enableFireworks: true,
          enableConfetti: true,
        },
      },
    },
  },
}

module.exports = {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFile,
  Notice,
  PluginSettingTab,
  Setting,
  mockApp,
  mockLeaf,
}
