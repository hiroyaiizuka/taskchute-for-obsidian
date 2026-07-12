/**
 * Jest stand-in for @xterm/xterm. Real xterm probes canvas APIs at module
 * load, which jsdom does not implement (noisy console.error) — and jsdom
 * tests must never instantiate a real terminal anyway (they mock the
 * TerminalViewAdapter instead). This stub keeps the module importable and
 * inert while RECORDING constructor options, writes, and lifecycle calls so
 * the adapter's xterm wiring can be asserted without a real terminal
 * (see terminal-view-adapter-xterm.test.ts).
 */
class Terminal {
  constructor(options) {
    this.options = options || {}
    this.writes = []
    this.dataCallbacks = []
    this.openedContainer = null
    this.focusCount = 0
    this.disposed = false
    Terminal.instances.push(this)
  }

  onData(callback) {
    this.dataCallbacks.push(callback)
    return {
      dispose: () => {
        const index = this.dataCallbacks.indexOf(callback)
        if (index >= 0) this.dataCallbacks.splice(index, 1)
      },
    }
  }

  open(container) {
    this.openedContainer = container || null
  }

  write(data) {
    this.writes.push(data)
  }

  focus() {
    this.focusCount += 1
  }

  dispose() {
    this.disposed = true
  }

  /** Test helper: simulate a user keystroke inside the terminal */
  emitData(data) {
    for (const callback of [...this.dataCallbacks]) {
      callback(data)
    }
  }
}

Terminal.instances = []

module.exports = { Terminal }
