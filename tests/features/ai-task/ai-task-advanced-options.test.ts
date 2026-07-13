import {
  AI_MODEL_PRESETS,
  AI_REASONING_BUDGETS,
  buildReasoningArgs,
  CUSTOM_AI_MODEL_VALUE,
  getAvailableReasoningModes,
} from '../../../src/features/ai-task/config/AiTaskAdvancedOptions'

describe('AI task advanced options', () => {
  test('exposes only verified current model IDs', () => {
    expect(AI_MODEL_PRESETS.claude.map((model) => model.id)).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
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
    expect(getAvailableReasoningModes('claude', '')).toEqual([
      'automatic',
    ])
    expect(getAvailableReasoningModes('codex', '')).toEqual([
      'automatic',
    ])
    expect(getAvailableReasoningModes('claude', 'claude-fable-5')).toEqual([
      'automatic',
      'specified',
      'ultra',
    ])
    expect(getAvailableReasoningModes('claude', 'claude-haiku-4-5')).toEqual([
      'automatic',
    ])
    expect(getAvailableReasoningModes('claude', CUSTOM_AI_MODEL_VALUE)).toEqual([
      'automatic',
      'specified',
    ])
    expect(getAvailableReasoningModes('codex', 'gpt-5.6-terra')).toEqual([
      'automatic',
      'specified',
      'ultra',
    ])
    expect(getAvailableReasoningModes('codex', 'gpt-5.6-luna')).toEqual([
      'automatic',
      'specified',
    ])
    expect(getAvailableReasoningModes('codex', CUSTOM_AI_MODEL_VALUE)).toEqual([
      'automatic',
      'specified',
    ])
  })
})
