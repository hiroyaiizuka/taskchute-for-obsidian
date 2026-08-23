/**
 * AI Task - Claude Code dispatcher
 *
 * Runs `claude -p --output-format stream-json --verbose [...args] -- PROMPT`
 * headlessly. `--verbose` is required by the CLI when combining `-p` with
 * stream-json output. Follow-ups add `--resume SESSION_ID` (claude 2.1.x:
 * `-r, --resume [value]`, combinable with `-p` + stream-json). Extra args
 * from the task note are appended after the defaults, and the positional
 * prompt always follows a `--` end-of-options separator so a prompt body
 * starting with `-` is never parsed as a flag.
 */

import type { AiStreamEvent } from '../../types'
import { parseClaudeLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

export class ClaudeCodeDispatcher extends HeadlessCliDispatcher {
  protected buildArgs(request: AiRunRequest): string[] {
    const args = ['-p']
    if (request.resumeSessionId !== undefined && request.resumeSessionId.length > 0) {
      args.push('--resume', request.resumeSessionId)
    }
    args.push('--output-format', 'stream-json', '--verbose')
    args.push(...(request.extraArgs ?? []))
    args.push('--', request.prompt)
    return args
  }

  protected parseLine(line: string): AiStreamEvent[] {
    return parseClaudeLine(line)
  }
}
