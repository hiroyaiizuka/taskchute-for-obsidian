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

const TFile = jest.fn().mockImplementation(function (path = 'test-file.md') {
  if (!(this instanceof TFile)) {
    return new TFile(path)
  }

  this.path = typeof path === 'string' ? path : 'test-file.md'
  const dotIndex = this.path.lastIndexOf('.')
  this.basename = dotIndex > -1 ? this.path.substring(0, dotIndex) : this.path
  this.extension = dotIndex > -1 ? this.path.substring(dotIndex + 1) : ''
})

const Notice = jest.fn()


/**
 * A real class, so subclasses can call super() and inherit the declarative
 * settings surface. The previous jest.fn() stand-in forced every settings suite
 * to build tabs with Object.create() to dodge the constructor.
 *
 * getControlValue/setControlValue mirror PluginSettingTab's documented
 * behavior: read from and write to `plugin.settings`, persisting through the
 * plugin's own saveSettings().
 */
class SettingTab {
  constructor(app, plugin) {
    this.app = app
    this.plugin = plugin
    this.containerEl = createMockElement('div')
    this.settingItems = []
  }

  getSettingDefinitions() {
    return []
  }

  update() {
    this.settingItems = this.getSettingDefinitions()
  }

  refreshDomState() {}

  getControlValue(key) {
    return this.plugin?.settings?.[key]
  }

  async setControlValue(key, value) {
    if (this.plugin?.settings) {
      this.plugin.settings[key] = value
    }
    await this.plugin?.saveSettings?.()
  }

  display() {}

  hide() {}
}

const PluginSettingTab = SettingTab

/**
 * Enough of SettingGroup for a `render:` callback to mount into. Real
 * definitions receive one of these as their second argument.
 */
class SettingGroup {
  constructor(containerEl) {
    this.containerEl = containerEl ?? createMockElement('div')
    // Match the container's kind: a real DOM node cannot adopt a mock element,
    // and callers pass either depending on what the code under test builds.
    this.listEl =
      typeof Node !== 'undefined' && this.containerEl instanceof Node
        ? this.containerEl.ownerDocument.createElement('div')
        : createMockElement('div')
    this.containerEl.appendChild?.(this.listEl)
    this.heading = undefined
  }

  setHeading(text) {
    this.heading = text
    return this
  }

  addClass(...classes) {
    classes.forEach((cls) => this.containerEl.classList?.add?.(cls))
    return this
  }

  addSetting(cb) {
    const setting = new Setting(this.listEl)
    cb?.(setting)
    return this
  }

  addSearch() {
    return this
  }

  addExtraButton() {
    return this
  }
}

const SettingInstances = []

class TextComponent {
  constructor(containerEl) {
    this.inputEl = createMockElement('input')
    this.inputElListeners = {}
    this.inputEl.addEventListener = jest.fn((type, handler) => {
      if (!this.inputElListeners[type]) {
        this.inputElListeners[type] = []
      }
      this.inputElListeners[type].push(handler)
      return undefined
    })
    this.inputEl.dispatchEvent = jest.fn((event) => {
      const listeners = this.inputElListeners[event.type] || []
      listeners.forEach((listener) => listener(event))
    })
    this._onChange = null
    this._onBlur = null
    this.containerEl = containerEl
    containerEl?.appendChild?.(this.inputEl)
  }

  setPlaceholder() {
    return this
  }

  setValue(value) {
    this.inputEl.value = value
    return this
  }

  getValue() {
    return this.inputEl.value
  }

  onChange(callback) {
    this._onChange = callback
    return this
  }

  async __triggerChange(value) {
    this.setValue(value)
    if (this._onChange) {
      await this._onChange(value)
    }
  }

  async __triggerEvent(type) {
    const listeners = this.inputElListeners[type] || []
    for (const listener of listeners) {
      await listener({ type, target: this.inputEl })
    }
  }
}

/**
 * Enough of ButtonComponent for a `render:` callback that builds its own
 * button — the activation form does, because the code field and the button
 * that spends it belong to one row.
 */
class ButtonComponent {
  constructor(containerEl) {
    this.buttonEl = createMockElement('button')
    this.text = ''
    this.cta = false
    this.disabled = false
    this._onClick = null
    this.containerEl = containerEl
    containerEl?.appendChild?.(this.buttonEl)
  }

  setButtonText(text) {
    this.text = text
    this.buttonEl.textContent = text
    return this
  }

  setCta() {
    this.cta = true
    return this
  }

  setDisabled(disabled) {
    this.disabled = disabled
    return this
  }

  setTooltip() {
    return this
  }

  setIcon(icon) {
    this.icon = icon
    return this
  }

  onClick(callback) {
    this._onClick = callback
    return this
  }

  async __click() {
    if (this._onClick) {
      await this._onClick()
    }
  }
}

class ExtraButtonComponent {
  constructor(containerEl) {
    this.extraSettingsEl = createMockElement('div')
    this.icon = null
    this.tooltip = null
    this.disabled = false
    this._onClick = null
    this.containerEl = containerEl
    containerEl?.appendChild?.(this.extraSettingsEl)
  }

  setIcon(icon) {
    this.icon = icon
    return this
  }

  setTooltip(tooltip) {
    this.tooltip = tooltip
    return this
  }

  setDisabled(disabled) {
    this.disabled = disabled
    return this
  }

  onClick(callback) {
    this._onClick = callback
    return this
  }

  async __click() {
    if (this._onClick) {
      await this._onClick()
    }
  }
}

class AbstractInputSuggest {
  constructor(app, inputEl) {
    this.app = app
    this.inputEl = inputEl
    this.onSelectCallback = null
    this.limit = 100
  }

  setValue(value) {
    this.inputEl.value = value
  }

  getValue() {
    return this.inputEl.value
  }

  async selectSuggestion(value, evt = new MouseEvent('click')) {
    if (this.onSelectCallback) {
      await this.onSelectCallback(value, evt)
    }
  }

  onSelect(callback) {
    this.onSelectCallback = callback
    return this
  }

  open() {}

  close() {}

  setSuggestions() {}

  renderSuggestion() {}
}

const Setting = jest.fn().mockImplementation(() => {
  const settingInstance = {
    settingEl: createMockElement('div'),
    nameEl: createMockElement('div'),
    descEl: createMockElement('div'),
    controlEl: createMockElement('div'),
    setName: jest.fn().mockReturnThis(),
    setDesc: jest.fn().mockReturnThis(),
    setClass: jest.fn().mockReturnThis(),
    addToggle: jest.fn().mockReturnThis(),
    addText: jest.fn().mockImplementation(function (callback) {
      if (!this.__textComponents) {
        this.__textComponents = []
      }
      const text = new TextComponent(createMockElement('div'))
      this.__textComponents.push(text)
      if (typeof callback === 'function') {
        callback(text)
      }
      return this
    }),
    addTextArea: jest.fn().mockReturnThis(),
    addButton: jest.fn().mockImplementation(function (callback) {
      if (!this.__buttons) {
        this.__buttons = []
      }
      const button = new ButtonComponent(this.controlEl)
      this.__buttons.push(button)
      if (typeof callback === 'function') {
        callback(button)
      }
      return this
    }),
    addDropdown: jest.fn().mockReturnThis(),
    addSlider: jest.fn().mockReturnThis(),
    addExtraButton: jest.fn().mockImplementation(function (callback) {
      if (!this.__extraButtons) {
        this.__extraButtons = []
      }
      const button = new ExtraButtonComponent(createMockElement('div'))
      this.__extraButtons.push(button)
      if (typeof callback === 'function') {
        callback(button)
      }
      return this
    }),
  }
  SettingInstances.push(settingInstance)
  return settingInstance
})
Setting.__instances = SettingInstances

const momentLib = require('moment')
const moment = (...args) => momentLib(...args)
Object.assign(moment, momentLib)

const requestUrl = jest.fn(async () => ({ status: 200, text: '', json: async () => ({}) }))

// DOM要素のモック関数
const createMockElement = (tag = 'div') => {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    __attributes: {},
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
    // Obsidian augments HTMLElement with these; code under test uses them
    // interchangeably with classList.
    addClass: jest.fn(function (...classes) {
      const present = this.className ? this.className.split(' ') : []
      classes.forEach((cls) => {
        if (cls && !present.includes(cls)) present.push(cls)
      })
      this.className = present.join(' ')
      return this
    }),
    removeClass: jest.fn(function (...classes) {
      const present = this.className ? this.className.split(' ') : []
      this.className = present.filter((cls) => !classes.includes(cls)).join(' ')
      return this
    }),
    hasClass: jest.fn(function (cls) {
      return this.className ? this.className.split(' ').includes(cls) : false
    }),
    setText: jest.fn(function (text) {
      this.textContent = text
      return this
    }),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    // Attributes are readable back: code under test sets aria-label and the
    // like through createEl's `attr`, and a test that cannot read them can
    // only assert against internals.
    setAttribute: jest.fn(function (name, value) {
      this.__attributes[name] = String(value)
    }),
    getAttribute: jest.fn(function (name) {
      return Object.hasOwn(this.__attributes, name)
        ? this.__attributes[name]
        : null
    }),
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
          el.setAttribute(key, value)
        })
      }
      this.appendChild(el)
      return el
    }),
    createDiv: jest.fn(function(options = {}) {
      return this.createEl('div', options)
    }),
    createSpan: jest.fn(function(options = {}) {
      return this.createEl('span', options)
    }),
    createSvg: jest.fn(function(tag, options = {}) {
      return this.createEl(tag, options)
    }),
    empty: jest.fn(function() {
      this.children = []
      this.innerHTML = ''
    }),
  }
  return element
}

class Modal {
  constructor(app) {
    this.app = app
    this.titleEl = createMockElement('h1')
    this.contentEl = createMockElement('div')
    this.open = jest.fn()
    this.close = jest.fn()
    this.setTitle = jest.fn()
  }
}

class SuggestModal {
  constructor(app) {
    this.app = app
    this.open = jest.fn()
    this.close = jest.fn()
    this.setPlaceholder = jest.fn()
  }

  getSuggestions() {
    return []
  }

  renderSuggestion() {}

  onChooseSuggestion() {}
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
    getAllLoadedFiles: jest.fn().mockReturnValue([]),
    read: jest.fn().mockResolvedValue(""),
    create: jest.fn().mockResolvedValue(null),
    modify: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(null),
    createFolder: jest.fn().mockResolvedValue(null),
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
        },
      },
    },
  },
}

const normalizePath = (path) => {
  // Normalize path by removing redundant slashes and dots
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\.$/, '')
}

const createEl = (tag, options = {}) => createMockElement(tag).createEl
  ? (() => {
      const parent = createMockElement('div')
      return parent.createEl(tag, options)
    })()
  : createMockElement(tag)

const createDiv = (options = {}) => {
  const parent = createMockElement('div')
  return parent.createDiv(options)
}

const createSpan = (options = {}) => {
  const parent = createMockElement('div')
  return parent.createSpan(options)
}

const createSvg = (tag, options = {}) => {
  const parent = createMockElement('div')
  return parent.createSvg(tag, options)
}

const activeDocument = document
const activeWindow = window
const getLanguage = jest.fn(() => 'en')
const setIcon = jest.fn((element, iconId) => {
  element?.setAttribute?.('data-icon', iconId)
})

if (typeof globalThis.createDiv === 'undefined') {
  Object.assign(globalThis, {
    activeDocument,
    activeWindow,
    createEl,
    createDiv,
    createSpan,
    createSvg,
  })
}

const TFolder = jest.fn().mockImplementation(() => ({
  path: "test-folder",
  name: "test-folder",
}))

// Suites that need a non-desktop runtime mock 'obsidian' locally; the shared
// mock stands in for the ordinary case, an Obsidian desktop app.
const Platform = { isDesktop: true, isMobile: false }

module.exports = {
  Platform,
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFile,
  TFolder,
  Modal,
  SuggestModal,
  TextComponent,
  ButtonComponent,
  ExtraButtonComponent,
  AbstractInputSuggest,
  Notice,
  PluginSettingTab,
  SettingTab,
  Setting,
  SettingGroup,
  moment,
  requestUrl,
  activeDocument,
  activeWindow,
  createEl,
  createDiv,
  createSpan,
  createSvg,
  getLanguage,
  setIcon,
  normalizePath,
  mockApp,
  mockLeaf,
}
