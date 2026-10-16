import {
  AI_MODEL_PRESETS,
  AI_REASONING_BUDGETS,
  buildReasoningArgs,
  getAvailableReasoningModes,
} from '@/features/ai-task/config/AiTaskAdvancedOptions'

describe('AI task advanced options', () => {
  test('built-in models: Claude Code aliases, and the Codex fallback list', () => {
    expect(AI_MODEL_PRESETS.claude.map((model) => model.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ])
    expect(AI_MODEL_PRESETS.codex.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
  })

  test('builds host-specific reasoning args only in specified mode', () => {
    expect(buildReasoningArgs('claude', 'automatic', 'high')).toEqual([])
    expect(buildReasoningArgs('claude', 'specified', 'high')).toEqual([
      '--effort=high',
    ])
    expect(buildReasoningArgs('codex', 'specified', 'xhigh')).toEqual([
      '--config',
      'model_reasoning_effort="xhigh"',
    ])
  })

  test('rejects unsupported budgets instead of emitting arbitrary config', () => {
    expect(AI_REASONING_BUDGETS.claude).not.toContain('ultra')
    expect(AI_REASONING_BUDGETS.codex).not.toContain('ultra')
    expect(buildReasoningArgs('claude', 'specified', 'ultra')).toEqual([])
    expect(buildReasoningArgs('codex', 'specified', 'invalid')).toEqual([])
  })

  test('maps each host Ultra mode to its documented parallel workflow', () => {
    expect(buildReasoningArgs('codex', 'ultra', 'medium')).toEqual([
      '--config',
      'model_reasoning_effort="ultra"',
    ])
    expect(buildReasoningArgs('claude', 'ultra', 'medium')).toEqual([
      '--effort=ultracode',
    ])
  })

  test('limits reasoning modes to each selected model capability', () => {
    expect(getAvailableReasoningModes('claude', '')).toEqual(['automatic'])
    expect(getAvailableReasoningModes('codex', '')).toEqual(['automatic'])
    expect(getAvailableReasoningModes('claude', 'fable')).toEqual([
      'automatic',
      'specified',
      'ultra',
    ])
    expect(getAvailableReasoningModes('claude', 'haiku')).toEqual(['automatic'])
    expect(getAvailableReasoningModes('codex', 'gpt-5.6-terra')).toEqual([
      'automatic',
      'specified',
      'ultra',
    ])
    expect(getAvailableReasoningModes('codex', 'gpt-5.6-luna')).toEqual([
      'automatic',
      'specified',
    ])
    expect(getAvailableReasoningModes('cursor', 'composer-2.5')).toEqual(['automatic'])
  })

  test("an older task's model the list does not have is not promised Ultra", () => {
    expect(
      getAvailableReasoningModes('claude', 'claude-opus-4-8', { isUnlisted: true }),
    ).toEqual(['automatic', 'specified'])
    expect(
      getAvailableReasoningModes('codex', 'private-codex-model', { isUnlisted: true }),
    ).toEqual(['automatic', 'specified'])
  })

  test("Codex follows the levels its own list gives for the model", () => {
    expect(
      getAvailableReasoningModes('codex', 'gpt-daybreak', { levels: ['low', 'ultra'] }),
    ).toEqual(['automatic', 'specified', 'ultra'])
    expect(
      getAvailableReasoningModes('codex', 'gpt-5.6-sol', { levels: ['low'] }),
    ).toEqual(['automatic', 'specified'])
  })
})
