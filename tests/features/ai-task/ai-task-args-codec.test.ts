import {
  AI_EXEC_MODE_VARIANTS,
  DEFAULT_AI_EXEC_MODE,
  decodeAiTaskArgs,
} from '@/features/ai-task/config/AiTaskArgsCodec'

const selectable = (...modelIds: string[]) => (modelId: string): boolean =>
  modelIds.includes(modelId)

describe('AI_EXEC_MODE_VARIANTS', () => {
  test('every agent offers manual, auto, and skip-permissions, with its own arguments', () => {
    const tokens = (host: keyof typeof AI_EXEC_MODE_VARIANTS) =>
      AI_EXEC_MODE_VARIANTS[host].map((variant) => [variant.id, variant.tokens])
    expect(tokens('claude')).toEqual([
      ['manual', ['--permission-mode', 'manual']],
      ['auto', ['--permission-mode', 'auto']],
      ['skip-permissions', ['--dangerously-skip-permissions']],
    ])
    expect(tokens('codex')).toEqual([
      ['manual', []],
      ['auto', ['--approve-for-me']],
      ['skip-permissions', ['--dangerously-bypass-approvals-and-sandbox']],
    ])
    expect(tokens('cursor')).toEqual([
      ['manual', []],
      ['auto', ['--sandbox', 'disabled']],
      ['skip-permissions', ['--force']],
    ])
    expect(AI_EXEC_MODE_VARIANTS.claude.map((variant) => variant.labelKey)).toEqual([
      'addTask.aiExecModeManual',
      'addTask.aiExecModeAuto',
      'addTask.aiExecModeSkipPermissions',
    ])
  })

  test('a new task starts in auto mode', () => {
    expect(DEFAULT_AI_EXEC_MODE).toBe('auto')
  })
})

describe('decodeAiTaskArgs', () => {
  test('returns modal defaults and preserves unrelated args in order', () => {
    const args = ['--verbose', '--config', 'unrelated=true', '--color=always']

    // No execution-mode arguments: an existing task reads as manual.
    expect(decodeAiTaskArgs('claude', args, selectable())).toEqual({
      execModeId: 'manual',
      execModeTokens: [],
      trustFolder: false,
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
      execModeTokens: ['--permission-mode', 'auto'],
      trustFolder: false,
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
      execModeTokens: ['--dangerously-skip-permissions'],
      trustFolder: false,
      modelId: 'claude-opus-4-8',
      reasoningMode: 'ultra',
      reasoningBudget: 'medium',
      passthroughArgs: [],
    })
  })

  test("reads Codex's former Full auto as auto and keeps its arguments as written", () => {
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
      execModeId: 'auto',
      execModeTokens: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
      trustFolder: false,
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
      execModeId: 'manual',
      execModeTokens: [],
      trustFolder: false,
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
      execModeId: 'manual',
      execModeTokens: [],
      trustFolder: false,
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

describe('execution modes in existing notes', () => {
  test.each([
    ['claude', ['--permission-mode', 'manual'], 'manual'],
    ['codex', ['--approve-for-me'], 'auto'],
    ['codex', ['--dangerously-bypass-approvals-and-sandbox'], 'skip-permissions'],
    ['cursor', ['--sandbox', 'disabled'], 'auto'],
    ['cursor', ['--force'], 'skip-permissions'],
    ['cursor', ['--yolo'], 'skip-permissions'],
  ] as const)('%s %j reads as %s', (host, args, mode) => {
    const decoded = decodeAiTaskArgs(host, [...args], selectable())
    expect(decoded.execModeId).toBe(mode)
    expect(decoded.execModeTokens).toEqual(args)
    expect(decoded.passthroughArgs).toEqual([])
  })
})

describe('trusting the folder', () => {
  test("reads Cursor's --trust as trusting the folder, wherever it is", () => {
    const decoded = decodeAiTaskArgs('cursor', ['--sandbox', 'disabled', '--trust', '--model=auto'], selectable('auto'))
    expect(decoded).toEqual(expect.objectContaining({ execModeId: 'auto', trustFolder: true, passthroughArgs: [] }))
  })

  test('an agent without a trust option keeps --trust as an ordinary argument', () => {
    const decoded = decodeAiTaskArgs('codex', ['--approve-for-me', '--trust'], selectable())
    expect(decoded.trustFolder).toBe(false)
    expect(decoded.passthroughArgs).toEqual(['--trust'])
  })
})

