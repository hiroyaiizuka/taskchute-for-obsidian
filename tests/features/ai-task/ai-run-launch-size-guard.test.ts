import {
  AI_RUN_MAX_LAUNCH_SIZE,
  AiRunLaunchTooLargeError,
  assertAiRunLaunchSize,
  estimateAiRunLaunchSize,
} from '../../../src/features/ai-task/services/AiRunLaunchSizeGuard'

describe('AI run launch-size preflight', () => {
  const base = {
    binaryPath: '/usr/local/bin/claude',
    binaryArgsPrefix: ['entrypoint.js'],
    extraArgs: ['--model', 'claude-opus'],
  } as const

  function promptAtEstimatedSize(target: number): string {
    const oneCharacterSize = estimateAiRunLaunchSize({
      ...base,
      prompt: 'x',
    })
    return 'x'.repeat(1 + target - oneCharacterSize)
  }

  test('allows the exact portable boundary and rejects one unit beyond it', () => {
    const boundaryPrompt = promptAtEstimatedSize(AI_RUN_MAX_LAUNCH_SIZE)
    const boundary = { ...base, prompt: boundaryPrompt }
    const overflow = { ...base, prompt: `${boundaryPrompt}x` }

    expect(estimateAiRunLaunchSize(boundary)).toBe(AI_RUN_MAX_LAUNCH_SIZE)
    expect(() => assertAiRunLaunchSize(boundary)).not.toThrow()
    expect(estimateAiRunLaunchSize(overflow)).toBe(AI_RUN_MAX_LAUNCH_SIZE + 1)
    expect(() => assertAiRunLaunchSize(overflow)).toThrow(
      AiRunLaunchTooLargeError,
    )
  })

  test('counts UTF-8 expansion and POSIX quote escaping, not only JS length', () => {
    const ascii = estimateAiRunLaunchSize({ ...base, prompt: 'a'.repeat(100) })
    const japanese = estimateAiRunLaunchSize({ ...base, prompt: 'あ'.repeat(100) })
    const quotes = estimateAiRunLaunchSize({ ...base, prompt: "'".repeat(100) })

    expect(japanese).toBeGreaterThan(ascii)
    expect(quotes).toBeGreaterThan(ascii)
  })
})
