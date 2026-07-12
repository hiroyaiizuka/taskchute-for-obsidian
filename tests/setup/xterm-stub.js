/**
 * Jest stand-in for @xterm/xterm. Real xterm probes canvas APIs at module
 * load, which jsdom does not implement (noisy console.error) — and jsdom
 * tests must never instantiate a real terminal anyway (they mock the
 * TerminalViewAdapter instead). This stub keeps the module importable and
 * inert; behavior around xterm is covered through the adapter interface.
 */
class Terminal {
  constructor(options) {
    this.options = options || {}
  }

  onData() {
    return { dispose: () => undefined }
  }

  open() {}

  write() {}

  focus() {}

  dispose() {}
}

module.exports = { Terminal }
