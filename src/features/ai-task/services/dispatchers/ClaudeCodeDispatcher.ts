/**
 * AI Task - Claude Code dispatcher
 *
 * Runs `claude -p --output-format stream-json --verbose [...args] -- PROMPT`
 * headlessly. `--verbose` is required by the CLI when combining `-p` with
 * stream-json output. Extra args from the task note are appended after the
 * defaults, and the positional prompt always follows a `--` end-of-options
 * separator so a prompt body starting with `-` is never parsed as a flag.
 */

import type { AiStreamEvent } from '../../types'
import { parseClaudeLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

export class ClaudeCodeDispatcher extends HeadlessCliDispatcher {
  protected buildArgs(request: AiRunRequest): string[] {
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(request.extraArgs ?? []),
      '--',
      request.prompt,
    ]
  }

  protected parseLine(line: string): AiStreamEvent[] {
    return parseClaudeLine(line)
  }
}
