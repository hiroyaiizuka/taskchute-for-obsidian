/**
 * AI Task - Codex dispatcher
 *
 * Runs `codex exec --json [--cd DIR] --skip-git-repo-check PROMPT` headlessly.
 * The prompt is always the trailing positional argument; unknown JSONL lines
 * degrade to raw events inside parseCodexLine.
 */

import type { AiStreamEvent } from '../../types'
import { parseCodexLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

export class CodexDispatcher extends HeadlessCliDispatcher {
  protected buildArgs(request: AiRunRequest): string[] {
    const args = ['exec', '--json']
    if (request.cwd !== undefined && request.cwd.length > 0) {
      args.push('--cd', request.cwd)
    }
    args.push('--skip-git-repo-check')
    args.push(...(request.extraArgs ?? []))
    args.push(request.prompt)
    return args
  }

  protected parseLine(line: string): AiStreamEvent[] {
    return parseCodexLine(line)
  }
}
