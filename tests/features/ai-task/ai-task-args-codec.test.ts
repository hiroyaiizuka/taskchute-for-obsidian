import {
  AI_EXEC_MODE_VARIANTS,
  decodeAiTaskArgs,
} from '../../../src/features/ai-task/config/AiTaskArgsCodec'

const selectable = (...modelIds: string[]) => (modelId: string): boolean =>
  modelIds.includes(modelId)

describe('AI_EXEC_MODE_VARIANTS', () => {
  test('exposes the persisted Claude and Codex execution-mode tokens', () => {
    expect(AI_EXEC_MODE_VARIANTS).toEqual({
      claude: [
        {
          id: 'default',
          labelKey: 'addTask.aiExecModeDefault',
          labelFallback: 'Normal',
          tokens: [],
        },
        {
          id: 'auto',
          labelKey: 'addTask.aiExecModeAuto',
          labelFallback: 'Auto mode',
          tokens: ['--permission-mode', 'auto'],
        },
        {
          id: 'skip-permissions',
          labelKey: 'addTask.aiExecModeSkipPermissions',
          labelFallback: 'Skip permissions',
          tokens: ['--dangerously-skip-permissions'],
        },
      ],
      codex: [
        {
          id: 'default',
          labelKey: 'addTask.aiExecModeDefault',
          labelFallback: 'Normal',
          tokens: [],
        },
        {
          id: 'full-auto',
          labelKey: 'addTask.aiExecModeFullAuto',
          labelFallback: 'Full auto',
          tokens: [
            '--ask-for-approval',
            'never',
            '--sandbox',
            'workspace-write',
          ],
        },
      ],
    })
  })
})

describe('decodeAiTaskArgs', () => {
  test('returns modal defaults and preserves unrelated args in order', () => {
    const args = ['--verbose', '--config', 'unrelated=true', '--color=always']

    expect(decodeAiTaskArgs('claude', args, selectable())).toEqual({
      execModeId: 'default',
      modelId: '',
      reasoningMode: 'automatic',
      reasoningBudget: 'medium',
      passthroughArgs: args,
    })
  })

  test('decodes Claude auto, equals-model, and a specified effort', () => {
    expect(
      decodeAiTaskArgs(
        'claude',
        [
          '--unknown-before',
          '--permission-mode',
          'auto',
          '--model=claude-fable-5',
          '--effort=max',
          '--unknown-after',
        ],
        selectable('claude-fable-5'),
      ),
    ).toEqual({
      execModeId: 'auto',
      modelId: 'claude-fable-5',
      reasoningMode: 'specified',
      reasoningBudget: 'max',
      passthroughArgs: ['--unknown-before', '--unknown-after'],
    })
  })

  test('decodes Claude skip-permissions, split-model, and Ultracode', () => {
    expect(
      decodeAiTaskArgs(
        'claude',
        [
          '--dangerously-skip-permissions',
          '--model',
          'claude-opus-4-8',
          '--effort=ultracode',
        ],
        selectable('claude-opus-4-8'),
      ),
    ).toEqual({
      execModeId: 'skip-permissions',
      modelId: 'claude-opus-4-8',
      reasoningMode: 'ultra',
      reasoningBudget: 'medium',
      passthroughArgs: [],
    })
  })

  test('decodes Codex full-auto, split-model, and a quoted effort config pair', () => {
    expect(
      decodeAiTaskArgs(
        'codex',
        [
          '--before',
          '--ask-for-approval',
          'never',
          '--sandbox',
          'workspace-write',
          '--model',
          'gpt-5.6-sol',
          '--config',
          'model_reasoning_effort="xhigh"',
          '--after',
        ],
        selectable('gpt-5.6-sol'),
      ),
    ).toEqual({
      execModeId: 'full-auto',
      modelId: 'gpt-5.6-sol',
      reasoningMode: 'specified',
      reasoningBudget: 'xhigh',
      passthroughArgs: ['--before', '--after'],
    })
  })

  test('maps Codex ultra effort to the ultra reasoning mode', () => {
    expect(
      decodeAiTaskArgs(
        'codex',
        ['--model=gpt-5.6-terra', '--config', 'model_reasoning_effort="ultra"'],
        selectable('gpt-5.6-terra'),
      ),
    ).toEqual({
      execModeId: 'default',
      modelId: 'gpt-5.6-terra',
      reasoningMode: 'ultra',
      reasoningBudget: 'medium',
      passthroughArgs: [],
    })
  })

  test('keeps unknown models, unsupported efforts, and incomplete pairs verbatim', () => {
    const args = [
      '--model=provider-new-model',
      '--model',
      'another-new-model',
      '--config',
      'model_reasoning_effort="extreme"',
      '--config',
      '--model',
    ]

    expect(decodeAiTaskArgs('codex', args, selectable('gpt-5.6-sol'))).toEqual({
      execModeId: 'default',
      modelId: '',
      reasoningMode: 'automatic',
      reasoningBudget: 'medium',
      passthroughArgs: args,
    })
  })

  test('does not consume another host reasoning syntax', () => {
    expect(
      decodeAiTaskArgs(
        'claude',
        ['--config', 'model_reasoning_effort="high"'],
        selectable(),
      ).passthroughArgs,
    ).toEqual(['--config', 'model_reasoning_effort="high"'])

    expect(
      decodeAiTaskArgs('codex', ['--effort=high'], selectable()).passthroughArgs,
    ).toEqual(['--effort=high'])
  })

  test('does not mutate the source args array', () => {
    const args = [
      '--permission-mode',
      'auto',
      '--model=claude-fable-5',
      '--effort=high',
      '--future-flag',
    ]
    const before = [...args]

    decodeAiTaskArgs('claude', args, selectable('claude-fable-5'))

    expect(args).toEqual(before)
  })
})
