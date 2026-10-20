import {
  AI_EXEC_MODE_VARIANTS,
  DEFAULT_AI_EXEC_MODE,
  decodeAiTaskArgs,
  requestsSkipPermissions,
  resolveAiTaskRunArgs,
} from '@/features/ai-task/config/AiTaskArgsCodec'
import { getAiAgent } from '@/features/ai-task/agents'

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


// LEV-386: a note only asks. What the task modal can write reaches the CLI,
// in its order; anything else is left out; skip-permissions needs this
// device's consent and is auto mode otherwise.
describe('resolveAiTaskRunArgs', () => {
  const run = (
    host: 'claude' | 'codex' | 'cursor',
    args: string[],
    allowSkipPermissions = false,
  ) => resolveAiTaskRunArgs(host, args, { allowSkipPermissions })

  test('keeps what the task modal writes, in order', () => {
    expect(
      run('claude', ['--permission-mode', 'auto', '--model', 'opus', '--effort=high']),
    ).toEqual({
      args: ['--permission-mode', 'auto', '--model', 'opus', '--effort=high'],
      ignoredArgs: [],
      skipPermissionsDowngraded: false,
      trustFolder: false,
    })
  })

  test('leaves out what the task modal cannot write', () => {
    const result = run('claude', [
      '--mcp-config', '{"mcpServers":{}}',
      '--model', 'sonnet',
      '--settings', 'hooks.json',
      '--permission-mode', 'bypassPermissions',
      '--add-dir', '/',
    ])
    expect(result.args).toEqual(['--model', 'sonnet'])
    expect(result.ignoredArgs).toEqual([
      '--mcp-config', '{"mcpServers":{}}',
      '--settings', 'hooks.json',
      '--permission-mode', 'bypassPermissions',
      '--add-dir', '/',
    ])
  })

  test('a model id that is not a plain id is left out with its flag', () => {
    expect(run('claude', ['--model', '--settings']).args).toEqual([])
    expect(run('claude', ['--model=x;y']).args).toEqual([])
  })

  test.each([
    ['claude', ['--dangerously-skip-permissions'], ['--permission-mode', 'auto']],
    ['codex', ['--dangerously-bypass-approvals-and-sandbox'], ['--approve-for-me']],
    ['cursor', ['--force'], ['--sandbox', 'disabled']],
    ['cursor', ['--yolo'], ['--sandbox', 'disabled']],
  ] as const)('%s: skip-permissions %j is auto mode without consent', (host, args, auto) => {
    expect(run(host, [...args])).toEqual({
      args: [...auto],
      ignoredArgs: [],
      skipPermissionsDowngraded: true,
      trustFolder: false,
    })
    expect(requestsSkipPermissions(host, [...args])).toBe(true)
  })

  test('with consent, skip-permissions is kept as written', () => {
    expect(run('codex', ['--dangerously-bypass-approvals-and-sandbox'], true)).toEqual({
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      ignoredArgs: [],
      skipPermissionsDowngraded: false,
      trustFolder: false,
    })
  })

  test("codex: only the reasoning --config form passes, not other overrides", () => {
    const result = run('codex', [
      '--config', 'model_reasoning_effort="high"',
      '--config', 'sandbox_mode="danger-full-access"',
      '-c', 'mcp_servers.x.command="sh"',
    ])
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="high"'])
    expect(result.ignoredArgs).toEqual([
      '--config', 'sandbox_mode="danger-full-access"',
      '-c', 'mcp_servers.x.command="sh"',
    ])
  })

  test('cursor: trusting the folder is something the modal writes', () => {
    expect(run('cursor', ['--trust', '--force'], true).args).toEqual(['--trust', '--force'])
  })

  test('a note that does not ask for skip-permissions is not flagged', () => {
    expect(requestsSkipPermissions('claude', ['--permission-mode', 'manual'])).toBe(false)
    expect(requestsSkipPermissions('claude', [])).toBe(false)
  })
})

// LEV-386 regression guard: everything the task modal can write passes
// through unchanged once skip-permissions is allowed — no legitimate task
// loses an argument to the filter.
describe('resolveAiTaskRunArgs keeps every modal-written combination', () => {
  const hosts = ['claude', 'codex', 'cursor'] as const

  for (const host of hosts) {
    test(`${host}`, () => {
      const agent = getAiAgent(host)
      const modes = [
        ...AI_EXEC_MODE_VARIANTS[host].map((variant) => variant.tokens),
        ...(agent.legacyExecModes ?? []).map((spelling) => spelling.tokens),
      ]
      const trusts: Array<readonly string[]> = [[], ...(agent.trustFolderArgs ? [agent.trustFolderArgs] : [])]
      const models: string[][] = [[], ['--model', 'opus'], ['--model', 'gpt-5.6-sol'], ['--model', 'an-unlisted/model-2']]
      const reasoning = agent.reasoning
      const efforts: string[][] = [
        [],
        ...(reasoning ? [...reasoning.budgets, reasoning.ultraValue].map((value) => reasoning.effortArgs(value)) : []),
      ]
      let checked = 0
      for (const mode of modes) {
        for (const trust of trusts) {
          for (const model of models) {
            for (const effort of efforts) {
              const args = [...mode, ...trust, ...model, ...effort]
              const result = resolveAiTaskRunArgs(host, args, { allowSkipPermissions: true })
              expect({ args: result.args, ignored: result.ignoredArgs }).toEqual({ args, ignored: [] })
              checked += 1
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(10)
    })
  }
})
