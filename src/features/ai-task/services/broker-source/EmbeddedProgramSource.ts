/**
 * Transport for the sibling programs the broker carries.
 *
 * The broker starts as `spawn(node, ['-e', buildTerminalBrokerSource()])`, and
 * Linux caps a single argv string at MAX_ARG_STRLEN = 32 * PAGE_SIZE = 131_072 bytes.
 * Exceeding it fails the execve with E2BIG, so the broker never starts at all —
 * on Linux only, which is why macOS never noticed. The guard and watchdog
 * programs the broker has to hand to its own children accounted for ~46 KB of
 * that budget when embedded as JSON string literals; gzipped and base64'd they
 * cost ~16 KB.
 *
 * Compression happens the first time the broker source is built and costs
 * ~1 ms; the broker inflates in ~0.1 ms. The encoded text still travels inside
 * argv, so this buys the headroom without moving anything into the environment
 * (where Linux `ps axeww` would expose it and every descendant would inherit
 * it) or onto disk.
 *
 * It must not happen at module init: main.js loads on mobile too, and zlib is
 * not there. See tests/guardrails/mobile-plugin-load.test.ts.
 */
import { Platform } from 'obsidian'

// Matches the lazy-require boundary used by the other Node-touching services;
// a static `import` of a builtin is rejected by the plugin lint rules.
declare function require(moduleId: string): unknown

interface NodeBufferLike {
  toString(encoding: string): string
}

interface ZlibModuleLike {
  gzipSync(data: string, options: { level: number }): NodeBufferLike
}

function zlibModule(): ZlibModuleLike {
  if (!Platform.isDesktop) {
    throw new Error('The AI terminal broker is desktop only; zlib is unavailable here.')
  }
  // eslint-disable-next-line import/no-nodejs-modules -- guarded by Platform.isDesktop above; the carried programs are compressed to fit one Linux argv string
  return require('zlib') as ZlibModuleLike
}

export function gzipBase64(source: string): string {
  // gzipSync encodes a string argument as UTF-8, so no Buffer is needed here.
  return zlibModule().gzipSync(source, { level: 9 }).toString('base64')
}

/**
 * Splice ahead of the first `inflateProgram(...)` call site. Kept plain ES2018
 * for the same reason as the rest of the broker program.
 */
export const INFLATE_PROGRAM_SOURCE =
  String.raw`function inflateProgram(encoded) {
  return require('zlib').gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
}`
