declare global {
  interface DomElementInfo {
    html?: string
  }

  interface SvgElementInfo {
    [key: string]: unknown
  }

  // Obsidian installs its DOM helpers (`createEl` / `createDiv` / `createSpan` /
  // `createSvg`) as globals on every window, including popout windows. Only the
  // main-window globals are declared by obsidian.d.ts, so declare the per-window
  // ones here: `doc.win.createEl(...)` is how an element is created inside the
  // window that owns `doc` (see obsidianmd/prefer-create-el).
  interface Window {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K]
    createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement
    createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement
    createSvg<K extends keyof SVGElementTagNameMap>(
      tag: K,
      o?: SvgElementInfo | string,
      callback?: (el: SVGElementTagNameMap[K]) => void,
    ): SVGElementTagNameMap[K]
  }
}

export {}
