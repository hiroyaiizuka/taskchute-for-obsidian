import { execFileSync } from 'child_process'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

/**
 * Bundles src/main.ts the way esbuild.config.mjs does, then loads it the way a
 * runtime without Node would, and reports every Node built-in the module graph
 * pulls in while it initialises.
 *
 * Runs in a child process: esbuild refuses to work under jsdom's TextEncoder,
 * and the shared jest setup needs jsdom. The probe builds its own jsdom window
 * so the bundled browser libraries (xterm vendors VS Code's platform
 * detection) initialise against a real DOM instead of hand-rolled stubs.
 */
const PROBE_SOURCE = `
const vm = require('vm')
const { builtinModules } = require('module')
const { buildSync } = require('esbuild')
const { JSDOM } = require('jsdom')

// The externals esbuild.config.mjs declares; Obsidian supplies them at runtime.
const EXTERNALS = [
  'obsidian', 'electron',
  '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
  '@codemirror/language', '@codemirror/lint', '@codemirror/search',
  '@codemirror/state', '@codemirror/view',
  '@lezer/common', '@lezer/highlight', '@lezer/lr',
  ...builtinModules,
]

const built = buildSync({
  entryPoints: ['src/main.ts'],
  absWorkingDir: process.cwd(),
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  external: EXTERNALS,
  treeShaking: true,
  logLevel: 'silent',
  write: false,
})

// Whatever the host provides answers with an endlessly chainable stub, so the
// load gets as far as it can instead of stopping at the first call into
// Obsidian's own API surface.
const hostModuleStub = () => new Proxy(function () {}, {
  get: (target, property) => {
    if (property === Symbol.iterator) return function* () {}
    if (typeof property === 'symbol') return undefined
    return hostModuleStub()
  },
  apply: () => hostModuleStub(),
  construct: () => hostModuleStub(),
})

const requested = []
const hostRequire = (id) => {
  if (!builtinModules.includes(id)) return hostModuleStub()
  requested.push(id)
  // Hand back the real module so the load continues and every offending
  // require is collected, not just the first one.
  return require(id)
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'app://obsidian.md/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const context = dom.getInternalVMContext()
const moduleObject = { exports: {} }
Object.assign(context, {
  module: moduleObject,
  exports: moduleObject.exports,
  require: hostRequire,
  // A phone: no Node, and process.platform is not something to branch on.
  process: { env: {}, platform: 'android' },
  Buffer,
  // jsdom leaves these off the window it hands back.
  TextEncoder,
  TextDecoder,
  // Obsidian's ambient globals, present on every platform.
  activeDocument: context.document,
  activeWindow: context.window,
})

let failure = null
try {
  vm.runInContext(built.outputFiles[0].text, context, { filename: 'main.js' })
} catch (error) {
  failure = error && error.stack ? error.stack : String(error)
}

console.log(JSON.stringify({ builtins: [...new Set(requested)], failure }))
`

interface ProbeResult {
  builtins: string[]
  failure: string | null
}

function loadOnHostWithoutNode(): ProbeResult {
  const stdout = execFileSync(process.execPath, ['-e', PROBE_SOURCE], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // jsdom prints "Not implemented: HTMLCanvasElement.prototype.getContext"
    // while xterm probes for a renderer. Capture it rather than letting it
    // land in the reporter; a real crash still arrives through the JSON.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout) as ProbeResult
}

/**
 * manifest.json declares isDesktopOnly: false, so main.js has to survive being
 * loaded on a runtime that has no Node.
 *
 * Lint cannot see this. Every require() in src/ already sits inside a loader
 * function, but TERMINAL_BROKER_SOURCE used to call one of those loaders from
 * module scope to gzip the carried programs, so plugin load on mobile died
 * with "Cannot find module 'zlib'" long before any Platform check could run.
 * The lint rule looks at the require site; this looks at what actually runs on
 * import.
 */
describe('mobile plugin load', () => {
  test('no Node built-in is required while the bundle initialises', () => {
    const { builtins, failure } = loadOnHostWithoutNode()
    expect(failure).toBeNull()
    expect(builtins).toEqual([])
  }, 180_000)
})
