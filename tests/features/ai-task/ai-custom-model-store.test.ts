import {
  AI_CUSTOM_MODEL_STORAGE_KEY,
  AI_MODEL_ID_SAFE_PATTERN,
  AiCustomModelStore,
  isSafeAiModelId,
} from '../../../src/features/ai-task/models/AiCustomModelStore'

describe('AiCustomModelStore', () => {
  test.each([
    ['gpt-5.6-sol', true],
    ['anthropic/claude-sonnet-5', true],
    ['model_name:v1.2', true],
    ['A', true],
    ['a'.repeat(100), true],
    ['', false],
    ['-leading-flag', false],
    ['model name', false],
    ['model;rm', false],
    ['model$(whoami)', false],
    ['a'.repeat(101), false],
  ])('validates model id %p as %p', (modelId, expected) => {
    expect(isSafeAiModelId(modelId)).toBe(expected)
    expect(AI_MODEL_ID_SAFE_PATTERN.test(modelId)).toBe(expected)
  })

  test('loads only runtime-valid, host-scoped custom models and removes collisions', () => {
    const loadLocalStorage = jest.fn(() => ({
      claude: [
        { id: '  private/opus:v1  ', label: '  Private Opus  ', description: '  Internal  ' },
        { id: 'private/opus:v1', label: 'Duplicate' },
        { id: 'claude-fable-5', label: 'Built-in collision' },
        { id: '-bad', label: 'Bad id' },
        { id: 'empty-label', label: '   ' },
        { id: 'bad-description', label: 'Bad description', description: 7 },
        null,
      ],
      codex: [{ id: 'custom-codex', label: 'Custom Codex' }],
      shell: [{ id: 'ignored-host', label: 'Ignored host' }],
    }))
    const store = new AiCustomModelStore({ loadLocalStorage })

    expect(loadLocalStorage).toHaveBeenCalledWith(AI_CUSTOM_MODEL_STORAGE_KEY)
    expect(store.getCustomModels('claude')).toEqual([
      {
        id: 'private/opus:v1',
        label: 'Private Opus',
        description: 'Internal',
      },
    ])
    expect(store.getCustomModels('codex')).toEqual([
      { id: 'custom-codex', label: 'Custom Codex' },
    ])
  })

  test('adds a normalized model, persists per-host state, and rejects duplicate IDs', () => {
    const saveLocalStorage = jest.fn()
    const store = new AiCustomModelStore({
      loadLocalStorage: () => undefined,
      saveLocalStorage,
    })

    expect(
      store.add('claude', {
        id: '  private/opus:v2 ',
        label: '  Private Opus 2 ',
        description: '  Team endpoint ',
      }),
    ).toEqual({
      ok: true,
      model: {
        id: 'private/opus:v2',
        label: 'Private Opus 2',
        description: 'Team endpoint',
      },
    })
    expect(saveLocalStorage).toHaveBeenLastCalledWith(
      AI_CUSTOM_MODEL_STORAGE_KEY,
      {
        claude: [
          {
            id: 'private/opus:v2',
            label: 'Private Opus 2',
            description: 'Team endpoint',
          },
        ],
        codex: [],
      },
    )

    expect(
      store.add('claude', { id: 'private/opus:v2', label: 'Duplicate custom' }),
    ).toEqual({ ok: false, error: 'duplicate-id' })
    expect(
      store.add('claude', { id: 'claude-fable-5', label: 'Duplicate built-in' }),
    ).toEqual({ ok: false, error: 'duplicate-id' })
    expect(
      store.add('codex', { id: 'gpt-5.6-sol', label: 'Duplicate Codex built-in' }),
    ).toEqual({ ok: false, error: 'duplicate-id' })
    expect(saveLocalStorage).toHaveBeenCalledTimes(1)
  })

  test('allows the same custom ID on a different host', () => {
    const store = new AiCustomModelStore()

    expect(store.add('claude', { id: 'private-model', label: 'Claude private' }).ok).toBe(
      true,
    )
    expect(store.add('codex', { id: 'private-model', label: 'Codex private' }).ok).toBe(
      true,
    )
    expect(store.getCustomModels('claude')[0]?.label).toBe('Claude private')
    expect(store.getCustomModels('codex')[0]?.label).toBe('Codex private')
  })

  test('returns validation errors without mutating or persisting state', () => {
    const saveLocalStorage = jest.fn()
    const store = new AiCustomModelStore({ saveLocalStorage })

    expect(store.add('claude', { id: '--dangerous', label: 'Bad' })).toEqual({
      ok: false,
      error: 'invalid-id',
    })
    expect(store.add('claude', { id: 'valid-id', label: '   ' })).toEqual({
      ok: false,
      error: 'invalid-label',
    })
    expect(store.getCustomModels('claude')).toEqual([])
    expect(saveLocalStorage).not.toHaveBeenCalled()
  })

  test('updates labels/descriptions without allowing the ID to change', () => {
    const saveLocalStorage = jest.fn()
    const store = new AiCustomModelStore({ saveLocalStorage })
    store.add('claude', {
      id: 'private-model',
      label: 'Private',
      description: 'Old',
    })
    saveLocalStorage.mockClear()

    expect(
      store.update('claude', 'private-model', {
        label: '  Updated  ',
        description: '   ',
      }),
    ).toEqual({
      ok: true,
      model: { id: 'private-model', label: 'Updated' },
    })
    expect(store.getCustomModels('claude')).toEqual([
      { id: 'private-model', label: 'Updated' },
    ])
    expect(saveLocalStorage).toHaveBeenCalledTimes(1)

    expect(store.update('claude', 'missing', { label: 'Nope' })).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(store.update('claude', 'private-model', { label: ' ' })).toEqual({
      ok: false,
      error: 'invalid-label',
    })
    expect(saveLocalStorage).toHaveBeenCalledTimes(1)
  })

  test('removes only the requested host model and reports whether it existed', () => {
    const saveLocalStorage = jest.fn()
    const store = new AiCustomModelStore({ saveLocalStorage })
    store.add('claude', { id: 'shared-id', label: 'Claude' })
    store.add('codex', { id: 'shared-id', label: 'Codex' })
    saveLocalStorage.mockClear()

    expect(store.remove('claude', 'shared-id')).toBe(true)
    expect(store.getCustomModels('claude')).toEqual([])
    expect(store.getCustomModels('codex')).toEqual([
      { id: 'shared-id', label: 'Codex' },
    ])
    expect(store.remove('claude', 'shared-id')).toBe(false)
    expect(saveLocalStorage).toHaveBeenCalledTimes(1)
  })

  test('returns defensive copies and tolerates unavailable device storage', () => {
    const store = new AiCustomModelStore({
      loadLocalStorage: () => {
        throw new Error('unavailable')
      },
      saveLocalStorage: () => {
        throw new Error('unavailable')
      },
    })

    expect(() =>
      store.add('claude', { id: 'private-model', label: 'Private' }),
    ).not.toThrow()
    const models = store.getCustomModels('claude')
    models[0].label = 'Mutated outside'
    expect(store.getCustomModels('claude')[0]?.label).toBe('Private')
  })
})
