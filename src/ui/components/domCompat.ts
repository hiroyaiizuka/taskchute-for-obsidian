export type CreateElOptions = {
  cls?: string | string[]
  text?: string
  type?: 'button' | 'reset' | 'submit'
  attr?: Record<string, string>
}

/** Accepts either of Obsidian's two `cls` shapes, and any spacing within them. */
const applyClasses = (element: HTMLElement, cls: string | string[] | undefined): void => {
  if (!cls) return
  const tokens = (Array.isArray(cls) ? cls : [cls]).flatMap((entry) => entry.split(' '))
  const named = tokens.filter((token) => token.length > 0)
  if (named.length > 0) {
    element.classList.add(...named)
  }
}

/**
 * `createEl()` is an Obsidian extension to `HTMLElement`, so it is present in
 * the app but not on the plain elements a jsdom test builds. Dialogs that have
 * to run under both call this instead: it uses the extension when the host
 * carries it and falls back to the standard DOM otherwise.
 */
export const createElCompat = <K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  options?: CreateElOptions,
): HTMLElementTagNameMap[K] => {
  // Called as a method rather than through `.call`, so `this` is bound by the
  // call itself: no unbound-method finding, and no assertion on the result.
  const host = parent as HTMLElement & {
    createEl?: (tagName: string, options?: Record<string, unknown>) => HTMLElement
  }
  if (typeof host.createEl === 'function') {
    // `cls` is applied here rather than handed to the host. Obsidian accepts a
    // string or an array, but the shims standing in for it across the test
    // suite each accept only one of the two -- some split a string, some pass
    // it straight to `classList.add`, which rejects anything with a space.
    // Applying the classes to the returned element sidesteps all of that and
    // is what every caller means anyway.
    const { cls, ...rest } = options ?? {}
    const element = host.createEl(tag, rest) as HTMLElementTagNameMap[K]
    applyClasses(element, cls)
    return element
  }
  const element = createEl(tag)
  applyClasses(element, options?.cls)
  if (options?.text !== undefined) {
    element.textContent = options.text
  }
  if (options?.type !== undefined && 'type' in element) {
    ;(element as HTMLButtonElement).type = options.type
  }
  if (options?.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      element.setAttribute(key, value)
    })
  }
  parent.appendChild(element)
  return element
}
