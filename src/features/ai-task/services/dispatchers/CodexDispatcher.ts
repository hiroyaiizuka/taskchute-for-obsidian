/**
 * AI Task - Codex dispatcher
 *
 * Runs `codex exec --json [--cd DIR] --skip-git-repo-check [...args] -- PROMPT`
 * headlessly. Follow-ups run `codex exec resume SESSION_ID --json
 * --skip-git-repo-check [...args] -- PROMPT` instead; per
 * `codex exec resume --help` (0.144.1) the resume subcommand takes
 * [SESSION_ID] [PROMPT] positionals and supports --json /
 * --skip-git-repo-check but has NO --cd flag (the session's original
 * working directory is kept; the spawn cwd still applies). The prompt is
 * always the trailing positional argument behind a `--` end-of-options
 * separator (so a prompt body starting with `-` is never parsed as a flag);
 * unknown JSONL lines degrade to raw events inside parseCodexLine.
 */

import type { AiStreamEvent } from '../../types'
import { parseCodexLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

export class CodexDispatcher extends HeadlessCliDispatcher {
  protected buildArgs(request: AiRunRequest): string[] {
    const resumeSessionId =
      request.resumeSessionId !== undefined && request.resumeSessionId.length > 0
        ? request.resumeSessionId
        : undefined

    const args = ['exec']
    if (resumeSessionId !== undefined) {
      args.push('resume', resumeSessionId)
    }
    args.push('--json')
    if (resumeSessionId === undefined && request.cwd !== undefined && request.cwd.length > 0) {
      args.push('--cd', request.cwd)
    }
    args.push('--skip-git-repo-check')
    args.push(...(request.extraArgs ?? []))
    args.push('--', request.prompt)
    return args
  }

  protected parseLine(line: string): AiStreamEvent[] {
    return parseCodexLine(line)
  }

  /**
   * codex prints this notice for ANY non-tty stdin — verified on-device with
   * codex 0.144.1 even though the gateway hands the child /dev/null — so it
   * is pure noise in the run log's stderr tail.
   */
  protected isNoiseStderrLine(line: string): boolean {
    return line.trim() === 'Reading additional input from stdin...'
  }
}
