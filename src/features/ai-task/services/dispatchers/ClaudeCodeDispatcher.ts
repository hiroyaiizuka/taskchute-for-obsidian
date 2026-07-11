/**
 * AI Task - Claude Code dispatcher
 *
 * Runs `claude -p PROMPT --output-format stream-json --verbose` headlessly.
 * `--verbose` is required by the CLI when combining `-p` with stream-json
 * output. Extra args from the task note are appended after the defaults.
 */

import type { AiStreamEvent } from '../../types'
import { parseClaudeLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

export class ClaudeCodeDispatcher extends HeadlessCliDispatcher {
  protected buildArgs(request: AiRunRequest): string[] {
    return [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      ...(request.extraArgs ?? []),
    ]
  }

  protected parseLine(line: string): AiStreamEvent[] {
    return parseClaudeLine(line)
  }
}
