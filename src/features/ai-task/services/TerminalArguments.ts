/**
 * Build the positional argv shared by the interactive terminal dispatcher
 * and the add-task modal's command preview.
 *
 * A non-empty prompt is always preceded by `--` so a dash-leading prompt can
 * never be interpreted as a CLI flag. Empty prompts intentionally open the
 * host's plain REPL without adding either token.
 */
export function buildTerminalArgs(
  extraArgs: readonly string[] | undefined,
  prompt: string,
): string[] {
  const args = [...(extraArgs ?? [])]
  if (prompt.length > 0) {
    args.push('--', prompt)
  }
  return args
}
