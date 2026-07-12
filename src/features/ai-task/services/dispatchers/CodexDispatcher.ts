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
 * Interactive-only approval-policy flags in ai_task_args are dropped before
 * the exec argv (see sanitizeExecExtraArgs below).
 */

import type { AiStreamEvent } from '../../types'
import { parseCodexLine } from '../streams/StreamJsonParser'
import { HeadlessCliDispatcher } from './Dispatcher'
import type { AiRunRequest } from './Dispatcher'

const APPROVAL_FLAG = '--ask-for-approval'
const APPROVAL_FLAG_SHORT = '-a'

/**
 * Drop interactive-only approval-policy flags from ai_task_args before the
 * headless exec argv. Task notes share ONE ai_task_args list across the
 * terminal and headless pipelines: the interactive `codex` REPL accepts
 * `-a/--ask-for-approval <policy>` (the modal's "Full auto" writes
 * `--ask-for-approval never --sandbox workspace-write`), but `codex exec`
 * (verified on 0.144.1) has no approval flag at all — approvals do not exist
 * non-interactively — and clap exits 2 on it, deterministically failing every
 * headless run. Dropping the flag is a faithful translation (exec never
 * asks); sandboxing flags such as `--sandbox` exist in both pipelines and
 * pass through untouched.
 *
 * All clap spellings are covered: separated (`-a never`,
 * `--ask-for-approval never`), `=`-joined (`-a=never`,
 * `--ask-for-approval=never`), and the short attached form (`-anever`). A
 * bare flag consumes the following token only when it exists and is not
 * another `-`-leading flag (clap would not accept a hyphen-leading value
 * either), so a trailing or misplaced bare `-a` never swallows a real flag.
 */
function sanitizeExecExtraArgs(args: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === APPROVAL_FLAG || arg === APPROVAL_FLAG_SHORT) {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        index += 1 // also skip the separated policy value token
      }
      continue
    }
    if (arg.startsWith(`${APPROVAL_FLAG}=`)) continue
    // '-a=never' and clap's attached '-anever' both start with '-a'.
    if (
      arg.startsWith(APPROVAL_FLAG_SHORT) &&
      arg.length > APPROVAL_FLAG_SHORT.length
    ) {
      continue
    }
    result.push(arg)
  }
  return result
}

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
    args.push(...sanitizeExecExtraArgs(request.extraArgs ?? []))
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
