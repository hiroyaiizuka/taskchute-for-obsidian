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
    this.resizeCallbacks = []
    this.openedContainer = null
    this.focusCount = 0
    this.disposed = false
    this.loadedAddons = []
    this.linkProviders = []
    this.linkProviderRegistrations = []
    /** Test helper: raw buffer lines returned through buffer.active */
    this.bufferLines = []
    /** Test helper: wrapped/wide-cell metadata keyed by buffer line. */
    this.bufferLineMetadata = []
    const self = this
    this.buffer = {
      active: {
        get length() {
          return self.bufferLines.length
        },
        getLine(index) {
          const metadata = self.bufferLineMetadata[index]
          const line = metadata?.text ?? self.bufferLines[index]
          if (line === undefined) return undefined
          const cells =
            metadata?.cells ??
            Array.from(line).map((char) => ({ chars: char, width: 1 }))
          return {
            isWrapped: metadata?.isWrapped ?? false,
            length: cells.length,
            getCell(cellIndex) {
              const cell = cells[cellIndex]
              if (!cell) return undefined
              return {
                getWidth() {
                  return cell.width
                },
                getChars() {
                  return cell.chars
                },
              }
            },
            translateToString(trimRight) {
              return trimRight ? line.replace(/[ \t]+$/, '') : line
            },
          }
        },
      },
    }
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

  onResize(callback) {
    this.resizeCallbacks.push(callback)
    return {
      dispose: () => {
        const index = this.resizeCallbacks.indexOf(callback)
        if (index >= 0) this.resizeCallbacks.splice(index, 1)
      },
    }
  }

  loadAddon(addon) {
    this.loadedAddons.push(addon)
    addon.activate?.(this)
  }

  registerLinkProvider(provider) {
    const registration = { provider, disposed: false }
    this.linkProviders.push(provider)
    this.linkProviderRegistrations.push(registration)
    return {
      dispose: () => {
        if (registration.disposed) return
        registration.disposed = true
        const index = this.linkProviders.indexOf(provider)
        if (index >= 0) this.linkProviders.splice(index, 1)
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
    for (const addon of this.loadedAddons) {
      addon.dispose?.()
    }
  }

  /** Test helper: simulate a user keystroke inside the terminal */
  emitData(data) {
    for (const callback of [...this.dataCallbacks]) {
      callback(data)
    }
  }

  /** Test helper: simulate xterm's fitted grid-size event. */
  emitResize(cols, rows) {
    for (const callback of [...this.resizeCallbacks]) {
      callback({ cols, rows })
    }
  }
}

Terminal.instances = []

/** Recording stand-in for @xterm/addon-fit used by adapter wiring tests. */
class FitAddon {
  constructor() {
    this.fitCount = 0
    this.disposed = false
    this.terminal = null
    FitAddon.instances.push(this)
  }

  activate(terminal) {
    this.terminal = terminal
  }

  fit() {
    this.fitCount += 1
  }

  dispose() {
    this.disposed = true
  }
}

FitAddon.instances = []

module.exports = { Terminal, FitAddon }
