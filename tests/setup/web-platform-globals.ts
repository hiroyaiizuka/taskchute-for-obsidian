/**
 * Web platform globals that jsdom omits but Obsidian's Electron/Chromium
 * runtime always provides.
 *
 * The license feature needs TextEncoder/TextDecoder for canonical token bytes
 * and crypto.getRandomValues for device-id generation. Polyfilling from Node
 * keeps the tests honest: the same implementations back both environments.
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
