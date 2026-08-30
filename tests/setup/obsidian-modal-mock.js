/**
 * Realistic stand-ins for the Obsidian UI primitives the plugin's modals are
 * built on: `Modal`, `Setting`, and the components `Setting` hands to its
 * `add*` callbacks.
 *
 * The thin mocks these replace returned detached objects, so a test could only
 * assert that a builder method had been called — never what the modal actually
 * rendered. These build the same real DOM Obsidian does, on jsdom nodes, so
 * tests can query a modal by the class names that Obsidian's own stylesheet
 * (and the plugin's) target:
 *
 *   .modal-container > .modal > .modal-close-button
 *                             > .modal-header > .modal-title
 *                             > .modal-content
 *   .setting-item > .setting-item-info > .setting-item-name
 *                                      > .setting-item-description
 *                 > .setting-item-control
 *
 * `open()` appends to the *active* window's body and `close()` tears the tree
 * down again, mirroring `Modal.prototype.open`/`close` — which is what lets a
 * test assert which window a modal opened in.
 *
 * Shared by `__mocks__/obsidian.js` and by the tests that declare their own
 * `jest.mock('obsidian', ...)` factory, so both see one behaviour.
 */

function el(doc, tag, cls) {
  const node = (doc ?? document).createElement(tag)
  if (cls) node.className = cls
  return node
}

/**
 * Containers reach these components from two directions: real jsdom nodes (a
 * modal's `contentEl`) and the mock elements the settings-tab mocks still
 * hand out. Real nodes win when present; `document` covers the mock ones.
 */
function docOf(containerEl) {
  return containerEl?.ownerDocument ?? document
}

/**
 * Records handlers as they are registered so `__triggerEvent` can await async
 * ones — a real `dispatchEvent` returns before an async handler settles, and
 * the settings tests depend on awaiting them.
 */
function trackListeners(node) {
  const listeners = {}
  const native = node.addEventListener.bind(node)
  node.addEventListener = (type, handler, options) => {
    ;(listeners[type] ??= []).push(handler)
    native(type, handler, options)
  }
  return listeners
}

async function runListeners(listeners, type, event) {
  for (const handler of listeners[type] ?? []) {
    await handler(event)
  }
}

/** Accepts the string or DocumentFragment Obsidian's setters take. */
function setNodeText(node, value) {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    node.textContent = value
    return
  }
  node.appendChild(value)
}

class ValueComponent {
  constructor(inputEl) {
    this.inputEl = inputEl
    this.changeHandlers = []
    this.__listeners = trackListeners(inputEl)
    this.inputEl.addEventListener('input', () => {
      this.changeHandlers.forEach((handler) => handler(this.getValue()))
    })
  }

  /** Test helper: set a value and await the change handlers. */
  async __triggerChange(value) {
    this.setValue(value)
    for (const handler of this.changeHandlers) {
      await handler(value)
    }
  }

  /** Test helper: fire an event and await its handlers, async ones included. */
  async __triggerEvent(type) {
    await runListeners(this.__listeners, type, { type, target: this.inputEl })
  }

  getValue() {
    return this.inputEl.value
  }

  setValue(value) {
    this.inputEl.value = value ?? ''
    return this
  }

  setPlaceholder(placeholder) {
    this.inputEl.placeholder = placeholder
    return this
  }

  setDisabled(disabled) {
    this.inputEl.disabled = Boolean(disabled)
    return this
  }

  onChange(handler) {
    this.changeHandlers.push(handler)
    return this
  }

  then(callback) {
    callback?.(this)
    return this
  }
}

class TextComponent extends ValueComponent {
  constructor(containerEl) {
    const input = el(docOf(containerEl), 'input')
    input.type = 'text'
    containerEl.appendChild(input)
    super(input)
  }
}

class TextAreaComponent extends ValueComponent {
  constructor(containerEl) {
    const area = el(docOf(containerEl), 'textarea')
    containerEl.appendChild(area)
    super(area)
  }
}

class DropdownComponent extends ValueComponent {
  constructor(containerEl) {
    const select = el(docOf(containerEl), 'select')
    containerEl.appendChild(select)
    super(select)
    // A <select> fires `change`, not `input`, when the user picks an option.
    this.inputEl.addEventListener('change', () => {
      this.changeHandlers.forEach((handler) => handler(this.getValue()))
    })
    this.selectEl = select
  }

  addOption(value, display) {
    const option = el(docOf(this.selectEl), 'option')
    option.value = value
    option.textContent = display
    this.selectEl.appendChild(option)
    return this
  }

  addOptions(options) {
    Object.entries(options ?? {}).forEach(([value, display]) => {
      this.addOption(value, display)
    })
    return this
  }
}

class ToggleComponent {
  constructor(containerEl) {
    const doc = docOf(containerEl)
    this.toggleEl = el(doc, 'div', 'checkbox-container')
    this.inputEl = el(doc, 'input')
    this.inputEl.type = 'checkbox'
    this.toggleEl.appendChild(this.inputEl)
    containerEl.appendChild(this.toggleEl)
    this.changeHandlers = []
    this.inputEl.addEventListener('change', () => {
      this.toggleEl.classList.toggle('is-enabled', this.inputEl.checked)
      this.changeHandlers.forEach((handler) => handler(this.inputEl.checked))
    })
  }

  getValue() {
    return this.inputEl.checked
  }

  setValue(value) {
    this.inputEl.checked = Boolean(value)
    this.toggleEl.classList.toggle('is-enabled', this.inputEl.checked)
    return this
  }

  setDisabled(disabled) {
    this.inputEl.disabled = Boolean(disabled)
    return this
  }

  setTooltip(tooltip) {
    this.toggleEl.setAttribute('aria-label', tooltip)
    return this
  }

  onChange(handler) {
    this.changeHandlers.push(handler)
    return this
  }

  then(callback) {
    callback?.(this)
    return this
  }
}

class ButtonComponent {
  constructor(containerEl) {
    this.buttonEl = el(docOf(containerEl), 'button')
    this.buttonEl.type = 'button'
    this.text = ''
    this.icon = undefined
    this.tooltip = undefined
    this.__listeners = trackListeners(this.buttonEl)
    containerEl.appendChild(this.buttonEl)
  }

  setButtonText(text) {
    this.text = text
    this.buttonEl.textContent = text
    return this
  }

  /** Test helper: invoke the click handlers and await async ones. */
  async __click() {
    await runListeners(this.__listeners, 'click', { type: 'click', target: this.buttonEl })
  }

  setCta() {
    this.buttonEl.classList.add('mod-cta')
    return this
  }

  removeCta() {
    this.buttonEl.classList.remove('mod-cta')
    return this
  }

  setWarning() {
    this.buttonEl.classList.add('mod-warning')
    return this
  }

  setDestructive() {
    this.buttonEl.classList.add('mod-destructive')
    return this
  }

  setClass(...classes) {
    this.buttonEl.classList.add(...classes.filter(Boolean))
    return this
  }

  setIcon(icon) {
    this.icon = icon
    this.buttonEl.setAttribute('data-icon', icon)
    return this
  }

  setTooltip(tooltip) {
    this.tooltip = tooltip
    this.buttonEl.setAttribute('aria-label', tooltip)
    return this
  }

  setDisabled(disabled) {
    this.buttonEl.disabled = Boolean(disabled)
    return this
  }

  onClick(handler) {
    this.buttonEl.addEventListener('click', handler)
    return this
  }

  then(callback) {
    callback?.(this)
    return this
  }
}

class ExtraButtonComponent extends ButtonComponent {
  constructor(containerEl) {
    super(containerEl)
    this.extraSettingsEl = this.buttonEl
    this.buttonEl.classList.add('clickable-icon', 'extra-setting-button')
  }
}

/** Mirrors Obsidian's `.setting-item` markup. */
class Setting {
  constructor(containerEl) {
    const doc = docOf(containerEl)
    this.settingEl = el(doc, 'div', 'setting-item')
    this.infoEl = el(doc, 'div', 'setting-item-info')
    this.nameEl = el(doc, 'div', 'setting-item-name')
    this.descEl = el(doc, 'div', 'setting-item-description')
    this.controlEl = el(doc, 'div', 'setting-item-control')
    this.infoEl.appendChild(this.nameEl)
    this.infoEl.appendChild(this.descEl)
    this.settingEl.appendChild(this.infoEl)
    this.settingEl.appendChild(this.controlEl)
    this.components = []
    this.__textComponents = []
    this.__buttons = []
    this.__extraButtons = []
    containerEl.appendChild(this.settingEl)
  }

  setName(name) {
    setNodeText(this.nameEl, name)
    return this
  }

  setDesc(desc) {
    setNodeText(this.descEl, desc)
    return this
  }

  setHeading() {
    this.settingEl.classList.add('setting-item-heading')
    return this
  }

  setClass(...classes) {
    this.settingEl.classList.add(...classes.filter(Boolean))
    return this
  }

  setTooltip(tooltip) {
    this.settingEl.setAttribute('aria-label', tooltip)
    return this
  }

  setDisabled(disabled) {
    this.settingEl.classList.toggle('is-disabled', Boolean(disabled))
    return this
  }

  addText(callback) {
    const text = new TextComponent(this.controlEl)
    this.__textComponents.push(text)
    return this.addComponent(text, callback)
  }

  addTextArea(callback) {
    return this.addComponent(new TextAreaComponent(this.controlEl), callback)
  }

  addSearch(callback) {
    const search = new TextComponent(this.controlEl)
    search.inputEl.type = 'search'
    return this.addComponent(search, callback)
  }

  addDropdown(callback) {
    return this.addComponent(new DropdownComponent(this.controlEl), callback)
  }

  addToggle(callback) {
    return this.addComponent(new ToggleComponent(this.controlEl), callback)
  }

  addButton(callback) {
    const button = new ButtonComponent(this.controlEl)
    this.__buttons.push(button)
    return this.addComponent(button, callback)
  }

  addExtraButton(callback) {
    const button = new ExtraButtonComponent(this.controlEl)
    this.__extraButtons.push(button)
    return this.addComponent(button, callback)
  }

  addComponent(component, callback) {
    this.components.push(component)
    callback?.(component)
    return this
  }

  then(callback) {
    callback?.(this)
    return this
  }
}

/** Mirrors Obsidian's modal markup and its open/close lifecycle. */
class Modal {
  constructor(app) {
    this.app = app
    const doc =
      typeof activeDocument !== 'undefined' && activeDocument ? activeDocument : document
    this.containerEl = el(doc, 'div', 'modal-container mod-dim')
    this.bgEl = el(doc, 'div', 'modal-bg')
    this.modalEl = el(doc, 'div', 'modal')
    this.closeEl = el(doc, 'div', 'modal-close-button')
    this.headerEl = el(doc, 'div', 'modal-header')
    this.titleEl = el(doc, 'div', 'modal-title')
    this.contentEl = el(doc, 'div', 'modal-content')

    this.headerEl.appendChild(this.titleEl)
    this.modalEl.appendChild(this.closeEl)
    this.modalEl.appendChild(this.headerEl)
    this.modalEl.appendChild(this.contentEl)
    this.containerEl.appendChild(this.bgEl)
    this.containerEl.appendChild(this.modalEl)

    this.closeEl.addEventListener('click', () => this.close())
    // Obsidian dismisses on a backdrop click too, and both routes go through
    // `close()` — which is where subclasses hang their unsaved-changes guards.
    this.bgEl.addEventListener('click', () => this.close())
    this.scope = { register: () => undefined, unregister: () => undefined }
    this.shouldRestoreSelection = false
  }

  setTitle(title) {
    setNodeText(this.titleEl, title)
    return this
  }

  setContent(content) {
    setNodeText(this.contentEl, content)
    return this
  }

  /** Obsidian opens on the focused window, not necessarily the main one. */
  open() {
    const doc =
      typeof activeDocument !== 'undefined' && activeDocument
        ? activeDocument
        : this.containerEl.ownerDocument ?? document
    doc.body.appendChild(this.containerEl)
    this.onOpen?.()
  }

  close() {
    this.onClose?.()
    this.containerEl.remove()
  }

  onOpen() {}

  onClose() {}
}

module.exports = {
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Modal,
  Setting,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
}
