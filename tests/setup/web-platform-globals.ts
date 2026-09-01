/**
 * Web platform globals that jsdom omits but Obsidian's Electron/Chromium
 * runtime always provides.
 *
 * The license feature needs TextEncoder/TextDecoder for canonical token bytes
 * and crypto.getRandomValues for device-id generation. Polyfilling from Node
 * keeps the tests honest: the same implementations back both environments.
 *
 * PointerEvent, the pointer-capture methods and elementFromPoint are the other
 * gap: jsdom ships none of them, and the task list reorders on Pointer Events
 * and hit-tests its drop target (TaskListPointerDrag).
 */
import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'

if (typeof globalThis.TextEncoder === 'undefined') {
  Object.assign(globalThis, { TextEncoder, TextDecoder })
}

// jsdom installs a crypto object without getRandomValues; patch the method
// rather than replacing the object, so anything else jsdom put there survives.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  const source = webcrypto as unknown as Crypto
  if (globalThis.crypto === undefined) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: source })
  } else {
    Object.defineProperty(globalThis.crypto, 'getRandomValues', {
      configurable: true,
      writable: true,
      value: source.getRandomValues.bind(source),
    })
  }
}

// jsdom implements MouseEvent but not PointerEvent, and no pointer capture at
// all. The shim carries only what the drag code reads -- the pointer identity
// and whether this is the primary one -- so a test that dispatches a pointer
// event exercises the same branch the real runtime takes.
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number
    readonly isPrimary: boolean
    readonly pointerType: string

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.isPrimary = init.isPrimary ?? true
      this.pointerType = init.pointerType ?? 'mouse'
    }
  }
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: PointerEventShim,
  })
}

if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = function setPointerCapture(): void {
    // Capture only affects which element receives later events; jsdom
    // dispatches wherever the test aims, so there is nothing to record.
  }
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {
    // Paired with the no-op above.
  }
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false
  }
}

// jsdom does no layout, so it cannot hit-test. The stub answers "nothing
// here"; a test that needs a drop target spies on it and says what is there.
if (typeof Document.prototype.elementFromPoint !== 'function') {
  Document.prototype.elementFromPoint = function elementFromPoint(): Element | null {
    return null
  }
}
