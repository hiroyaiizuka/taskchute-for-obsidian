type DomOptions = {
  cls?: string | string[]
  text?: string
  attr?: Record<string, string | number | boolean | null>
  type?: string
  value?: string
}

type SvgOptions = {
  cls?: string | string[]
  attr?: Record<string, string | number | boolean | null>
}

function applyDomOptions(element: HTMLElement, options?: DomOptions | string): void {
  if (!options) return
  if (typeof options === 'string') {
    element.className = options
    return
  }
  if (options.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(' ')
    element.classList.add(...classes.filter(Boolean))
  }
  if (options.text !== undefined) {
    element.textContent = options.text
  }
  if (options.type !== undefined && 'type' in element) {
    ;(element as HTMLInputElement | HTMLButtonElement).type = options.type
  }
  if (options.value !== undefined && 'value' in element) {
    ;(element as HTMLInputElement).value = options.value
  }
  if (options.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      if (value === null) return
      element.setAttribute(key, String(value))
    })
  }
}

function applySvgOptions(element: SVGElement, options?: SvgOptions | string): void {
  if (!options) return
  if (typeof options === 'string') {
    element.setAttribute('class', options)
    return
  }
  if (options.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(' ')
    element.setAttribute('class', classes.filter(Boolean).join(' '))
  }
  if (options.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      if (value === null) return
      element.setAttribute(key, String(value))
    })
  }
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: DomOptions | string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  applyDomOptions(element, options)
  return element
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  options?: SvgOptions | string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  applySvgOptions(element, options)
  return element
}

Object.assign(globalThis, {
  activeDocument: document,
  activeWindow: window,
  createEl: createHtmlElement,
  createDiv: (options?: DomOptions | string) => createHtmlElement('div', options),
  createSpan: (options?: DomOptions | string) => createHtmlElement('span', options),
  createSvg: createSvgElement,
})

Object.defineProperties(Node.prototype, {
  createEl: {
    configurable: true,
    writable: true,
    value(this: Node, tag: keyof HTMLElementTagNameMap, options?: DomOptions | string, callback?: (el: HTMLElement) => void) {
      const element = createHtmlElement(tag, options)
      this.appendChild(element)
      callback?.(element)
      return element
    },
  },
  createDiv: {
    configurable: true,
    writable: true,
    value(this: Node, options?: DomOptions | string, callback?: (el: HTMLDivElement) => void) {
      const element = createHtmlElement('div', options)
      this.appendChild(element)
      callback?.(element)
      return element
    },
  },
  createSpan: {
    configurable: true,
    writable: true,
    value(this: Node, options?: DomOptions | string, callback?: (el: HTMLSpanElement) => void) {
      const element = createHtmlElement('span', options)
      this.appendChild(element)
      callback?.(element)
      return element
    },
  },
  createSvg: {
    configurable: true,
    writable: true,
    value(this: Node, tag: keyof SVGElementTagNameMap, options?: SvgOptions | string, callback?: (el: SVGElement) => void) {
      const element = createSvgElement(tag, options)
      this.appendChild(element)
      callback?.(element)
      return element
    },
  },
  empty: {
    configurable: true,
    writable: true,
    value(this: Node) {
      while (this.firstChild) {
        this.removeChild(this.firstChild)
      }
    },
  },
})

HTMLElement.prototype.setAttr = function setAttr(name: string, value: string | number | boolean): HTMLElement {
  this.setAttribute(name, String(value))
  return this
}

Element.prototype.addClass = function addClass(...classes: string[]): Element {
  this.classList.add(...classes)
  return this
}

Element.prototype.removeClass = function removeClass(...classes: string[]): Element {
  this.classList.remove(...classes)
  return this
}
