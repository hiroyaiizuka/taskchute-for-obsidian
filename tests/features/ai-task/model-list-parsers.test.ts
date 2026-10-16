import { claudeAgent } from '@/features/ai-task/agents/claude'
import { codexAgent } from '@/features/ai-task/agents/codex'
import { cursorAgent } from '@/features/ai-task/agents/cursor'
import type { AiDefaultModelSource } from '@/features/ai-task/agents/AiAgentDefinition'
import { createModelListFetcher } from '@/features/ai-task/models/modelListSources'

// An excerpt of `cursor-agent models` (2026.10.14), zero-width spaces included.
const CURSOR_OUTPUT = [
  'Available models',
  '',
  'auto - Auto (current, default)',
  'gpt-5.3-codex-low - Codex 5.3 Low',
  'gpt-5.3-codex - Codex 5.3',
  'gpt-5.3-codex-high-fast - Codex 5.3 High Fast',
  'cursor-grok-4.5-high - Grok 4.5',
  'grok-4.7-low - Grok 4.7  Low',
  'grok-4.7-medium - Grok 4.7  Medium',
  'grok-4.7-medium-fast - Grok 4.7  Medium Fast​​',
  'claude-opus-5-5-low - Claude Opus 5.5 1M Low',
  'claude-opus-5-5-medium - Claude Opus 5.5 1M',
  'claude-opus-5-5-medium-fast - Claude Opus 5.5 1M Fast',
  'claude-opus-5-high - Claude Opus 5 1M',
  'claude-fable-5-1-medium - Claude Fable 5.1 1M Medium (NO ZDR)',
  '',
].join('\n')

function codexOutput(models: unknown[]): string {
  return `WARNING: something on stderr first\n${JSON.stringify({ models })}`
}

function source(files: Record<string, string>, env: Record<string, string> = {}): AiDefaultModelSource {
  return {
    home: '/home/me',
    env,
    join: (...parts) => parts.join('/'),
    readText: async (path) => files[path] ?? null,
  }
}

describe('Cursor model list', () => {
  test('one row per model, newest version only, without auto or variant words', () => {
    expect(cursorAgent.modelList?.parse(CURSOR_OUTPUT)).toEqual([
      { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
      { id: 'grok-4.7-medium', label: 'Grok 4.7' },
      { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5' },
      { id: 'claude-fable-5-1-medium', label: 'Claude Fable 5.1 (NO ZDR)' },
    ])
  })

  test('output without models throws, so the previous list stays', () => {
    expect(() => cursorAgent.modelList?.parse('Error: Authentication required.')).toThrow()
  })

  test('the default model comes from cli-config.json', async () => {
    const config = JSON.stringify({ model: { modelId: 'default', displayName: 'Auto' } })
    expect(await cursorAgent.defaultModel?.(source({ '/home/me/.cursor/cli-config.json': config }))).toBe('Auto')
    expect(await cursorAgent.defaultModel?.(source({}))).toBeNull()
    expect(await cursorAgent.defaultModel?.(source({ '/home/me/.cursor/cli-config.json': '{' }))).toBeNull()
  })
})

describe('Codex model list', () => {
  test('listed models only, newest per line, with their reasoning levels', () => {
    const output = codexOutput([
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
      { slug: 'gpt-5.5-sol', display_name: 'GPT-5.5-Sol', visibility: 'list', supported_reasoning_levels: [] },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
      { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' },
    ])
    expect(codexAgent.modelList?.parse(output)).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoningLevels: ['low', 'ultra'] },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', reasoningLevels: ['high'] },
    ])
  })

  test('an unexpected shape throws', () => {
    expect(() => codexAgent.modelList?.parse('{"data": []}')).toThrow()
    expect(() => codexAgent.modelList?.parse(codexOutput([{ slug: 'x', visibility: 'hide' }]))).toThrow()
    expect(() => codexAgent.modelList?.parse('not json')).toThrow()
  })

  test('Ultra follows the levels the list gives', () => {
    const modes = codexAgent.reasoning!.modesFor
    expect(modes('gpt-daybreak', false, ['low', 'ultra'])).toEqual(['automatic', 'specified', 'ultra'])
    expect(modes('gpt-5.6-sol', false, ['low', 'high'])).toEqual(['automatic', 'specified'])
    // The built-in list, without levels.
    expect(modes('gpt-5.6-sol', false)).toEqual(['automatic', 'specified', 'ultra'])
    expect(modes('gpt-5.6-luna', false)).toEqual(['automatic', 'specified'])
    expect(modes('old-model', true)).toEqual(['automatic', 'specified'])
  })

  test('the default model is the top-level model in config.toml', async () => {
    const toml = 'approval_policy = "never"\nmodel = "gpt-5.6-terra"\n\n[profiles.x]\nmodel = "other"\n'
    expect(await codexAgent.defaultModel?.(source({ '/home/me/.codex/config.toml': toml }))).toBe('gpt-5.6-terra')
    const onlyInTable = '[profiles.x]\nmodel = "other"\n'
    expect(await codexAgent.defaultModel?.(source({ '/home/me/.codex/config.toml': onlyInTable }))).toBeNull()
  })
})

describe('Claude Code models', () => {
  test('are the aliases, which always mean the newest version', () => {
    expect(claudeAgent.models.map((model) => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(claudeAgent.modelList).toBeUndefined()
  })

  test('Haiku takes no effort; an unlisted model is not promised Ultracode', () => {
    const modes = claudeAgent.reasoning!.modesFor
    expect(modes('haiku', false)).toEqual(['automatic'])
    expect(modes('claude-haiku-4-5', true)).toEqual(['automatic'])
    expect(modes('opus', false)).toEqual(['automatic', 'specified', 'ultra'])
    expect(modes('claude-opus-4-8', true)).toEqual(['automatic', 'specified'])
  })

  test('the default model comes from ANTHROPIC_MODEL, then settings.json', async () => {
    const settings = JSON.stringify({ model: 'sonnet' })
    expect(await claudeAgent.defaultModel?.(source({ '/home/me/.claude/settings.json': settings }))).toBe('sonnet')
    expect(
      await claudeAgent.defaultModel?.(source({ '/home/me/.claude/settings.json': settings }, { ANTHROPIC_MODEL: 'opus' })),
    ).toBe('opus')
    expect(await claudeAgent.defaultModel?.(source({}))).toBeNull()
  })
})

describe('asking the CLI for its list', () => {
  test('reads a coloured list as a plain one', async () => {
    const coloured =
      '\u001b[2mAvailable models\u001b[22m\n\n\u001b[32mauto\u001b[39m \u001b[2m- Auto\u001b[22m\u001b[2m (current, default)\u001b[22m\n' +
      '\u001b[36mcomposer-2.5\u001b[39m \u001b[2m- Composer 2.5\u001b[22m\n'
    const gateway = {
      execCapture: jest.fn(async () => ({ code: 0, stdout: coloured, stderr: '', timedOut: false })),
      getBaseEnv: () => ({}),
      getHomeDirectory: () => undefined,
      statPath: async () => null,
      readFileRange: async () => '',
    }
    const fetch = createModelListFetcher(gateway, { resolve: async () => '/usr/bin/cursor-agent' })
    expect(await fetch('cursor')).toEqual([{ id: 'composer-2.5', label: 'Composer 2.5' }])
    expect(gateway.execCapture).toHaveBeenCalledWith('/usr/bin/cursor-agent', ['models'], expect.any(Number), undefined)
  })

  test('a failed run throws', async () => {
    const gateway = {
      execCapture: jest.fn(async () => ({ code: 1, stdout: '', stderr: 'Authentication required', timedOut: false })),
      getBaseEnv: () => ({}),
      getHomeDirectory: () => undefined,
      statPath: async () => null,
      readFileRange: async () => '',
    }
    await expect(createModelListFetcher(gateway, { resolve: async () => 'cursor-agent' })('cursor')).rejects.toThrow()
  })
})
