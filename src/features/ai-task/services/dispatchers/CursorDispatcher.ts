/**
 * AI Task - Cursor dispatcher
 *
 * Runs `cursor-agent -p --output-format stream-json --trust [...args] -- PROMPT`
 * headlessly (verified on 2026.10.01). `--trust` is required: without it a
 * headless run in a folder not yet trusted stops at a trust prompt and exits
 * 1. Follow-ups add `--resume SESSION_ID`; the session keeps its working
 * directory, which is the spawn cwd. The prompt always follows a `--`
 * end-of-options separator so a prompt body starting with `-` is never
 * parsed as a flag.
 */

import type { AiStreamEvent } from '@/features/ai-task/types'
import { parseCursorLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

export class CursorDispatcher extends HeadlessCliDispatcher {
  protected buildArgs(request: AiRunRequest): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--trust']
    if (request.resumeSessionId !== undefined && request.resumeSessionId.length > 0) {
      args.push('--resume', request.resumeSessionId)
    }
    args.push(...(request.extraArgs ?? []))
    args.push('--', request.prompt)
    return args
  }

  protected parseLine(line: string): AiStreamEvent[] {
    return parseCursorLine(line)
  }
}
