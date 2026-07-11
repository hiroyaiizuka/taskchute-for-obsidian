/**
 * AI Task - CLI binary locator
 *
 * Resolves the absolute path of a host CLI binary. Resolution order:
 *   1. settings override (aiTaskClaudePath / aiTaskCodexPath)
 *   2. session cache
 *   3. `which <host>` in a login shell (GUI apps often lack the user PATH)
 *   4. known install location probes
 * Failures throw AiBinaryNotFoundError and are never cached.
 */

import type { AiTaskHost } from '../types'
import type { ProcessGateway } from './NodeProcessGateway'

export const WHICH_TIMEOUT_MS = 10_000
export const PROBE_TIMEOUT_MS = 2_000

const PROBE_COMMAND = '/bin/test'
const KNOWN_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

export interface AiBinaryPathOverrides {
  aiTaskClaudePath?: string
  aiTaskCodexPath?: string
}

export type BinaryLocatorGateway = Pick<
  ProcessGateway,
  'execCapture' | 'getShellPath' | 'getBaseEnv'
>

export class AiBinaryNotFoundError extends Error {
  readonly host: AiTaskHost

  constructor(host: AiTaskHost) {
    super(`Could not locate the ${host} CLI binary`)
    this.name = 'AiBinaryNotFoundError'
    this.host = host
  }
}

export class BinaryLocator {
  private readonly cache = new Map<AiTaskHost, string>()

  constructor(
    private readonly gateway: BinaryLocatorGateway,
    private readonly getOverrides: () => AiBinaryPathOverrides,
  ) {}

  async resolve(host: AiTaskHost): Promise<string> {
    const override = this.readOverride(host)
    if (override !== undefined) return override

    const cached = this.cache.get(host)
    if (cached !== undefined) return cached

    const detected = (await this.detectViaWhich(host)) ?? (await this.probeKnownPaths(host))
    if (detected === undefined) {
      throw new AiBinaryNotFoundError(host)
    }
    this.cache.set(host, detected)
    return detected
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  private readOverride(host: AiTaskHost): string | undefined {
    const overrides = this.getOverrides()
    const value = host === 'claude' ? overrides.aiTaskClaudePath : overrides.aiTaskCodexPath
    const trimmed = value?.trim()
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
  }

  private async detectViaWhich(host: AiTaskHost): Promise<string | undefined> {
    try {
      const result = await this.gateway.execCapture(
        this.gateway.getShellPath(),
        ['-lc', `which ${host}`],
        WHICH_TIMEOUT_MS,
      )
      if (result.code !== 0) return undefined
      const firstLine = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      return firstLine !== undefined && firstLine.startsWith('/') ? firstLine : undefined
    } catch {
      return undefined
    }
  }

  private candidatePaths(host: AiTaskHost): string[] {
    const home = this.gateway.getBaseEnv()['HOME']?.trim()
    const dirs =
      home !== undefined && home.length > 0
        ? [`${home}/.local/bin`, ...KNOWN_BIN_DIRS]
        : [...KNOWN_BIN_DIRS]
    return dirs.map((dir) => `${dir}/${host}`)
  }

  private async probeKnownPaths(host: AiTaskHost): Promise<string | undefined> {
    for (const candidate of this.candidatePaths(host)) {
      try {
        const result = await this.gateway.execCapture(
          PROBE_COMMAND,
          ['-x', candidate],
          PROBE_TIMEOUT_MS,
        )
        if (result.code === 0) return candidate
      } catch {
        // Probe errors mean "not here"; keep trying the next candidate.
      }
    }
    return undefined
  }
}
