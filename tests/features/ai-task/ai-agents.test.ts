import { getAiAgent, listAiAgents } from '@/features/ai-task/agents'
import { decodeAiTaskArgs } from '@/features/ai-task/config/AiTaskArgsCodec'
import { buildReasoningArgs } from '@/features/ai-task/config/AiTaskAdvancedOptions'
import { AI_TASK_HOSTS } from '@/features/ai-task/types'

// Every agent a task can run is one definition. These check the definitions
// are complete and consistent, so a new agent cannot be half-registered.

describe('AI agent definitions', () => {
  test('there is one definition per agent, listed in AI_TASK_HOSTS order', () => {
    expect(listAiAgents().map((agent) => agent.id)).toEqual([...AI_TASK_HOSTS])
    for (const host of AI_TASK_HOSTS) expect(getAiAgent(host).id).toBe(host)
  })

  test('commands and CLI path settings are distinct, and commands are plain names', () => {
    const agents = listAiAgents()
    const commands = agents.map((agent) => agent.command)
    const settingKeys = agents.map((agent) => agent.pathSetting.key)
    expect(new Set(commands).size).toBe(agents.length)
    expect(new Set(settingKeys).size).toBe(agents.length)
    // Run by name in a login shell and looked up with where.exe: no paths, spaces, or flags.
    for (const command of commands) expect(command).toMatch(/^[a-z0-9][a-z0-9_-]*$/u)
  })

  test("each agent's first execution mode is the default, with no arguments", () => {
    for (const agent of listAiAgents()) {
      expect(agent.execModes[0]).toEqual(expect.objectContaining({ id: 'default', tokens: [] }))
      const ids = agent.execModes.map((mode) => mode.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('built-in model ids are unique per agent', () => {
    for (const agent of listAiAgents()) {
      const ids = agent.models.map((model) => model.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('every reasoning value an agent writes is read back as the same choice', () => {
    for (const agent of listAiAgents()) {
      const reasoning = agent.reasoning
      if (reasoning === null) continue
      for (const budget of reasoning.budgets) {
        const args = buildReasoningArgs(agent.id, 'specified', budget)
        expect(reasoning.effortAt(args, 0)).toEqual({ length: args.length, value: budget })
        const decoded = decodeAiTaskArgs(agent.id, args, () => false)
        expect(decoded).toEqual(
          expect.objectContaining({ reasoningMode: 'specified', reasoningBudget: budget, passthroughArgs: [] }),
        )
      }
      const ultra = buildReasoningArgs(agent.id, 'ultra', 'medium')
      expect(decodeAiTaskArgs(agent.id, ultra, () => false)).toEqual(
        expect.objectContaining({ reasoningMode: 'ultra', passthroughArgs: [] }),
      )
    }
  })

  test("one agent's reasoning option is passed through untouched for another", () => {
    const claudeEffort = buildReasoningArgs('claude', 'specified', 'high')
    expect(decodeAiTaskArgs('codex', claudeEffort, () => false).passthroughArgs).toEqual(claudeEffort)
    const codexEffort = buildReasoningArgs('codex', 'specified', 'high')
    expect(decodeAiTaskArgs('claude', codexEffort, () => false).passthroughArgs).toEqual(codexEffort)
  })
})
