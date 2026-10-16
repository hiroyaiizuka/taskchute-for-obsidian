/**
 * AI Task - the agents a task can run
 *
 * To add an agent: add its id to AI_TASK_HOSTS (types.ts), write its
 * definition next to these, register it here, and add its strings.
 */

import { AI_TASK_HOSTS, type AiTaskHost } from '../types'
import type { AiAgentDefinition } from './AiAgentDefinition'
import { claudeAgent } from './claude'
import { codexAgent } from './codex'
import { cursorAgent } from './cursor'

export type { AiAgentDefinition, AiCliPathSettingKey } from './AiAgentDefinition'

const AI_AGENTS: Record<AiTaskHost, AiAgentDefinition> = {
  claude: claudeAgent,
  codex: codexAgent,
  cursor: cursorAgent,
}

export function getAiAgent(host: AiTaskHost): AiAgentDefinition {
  return AI_AGENTS[host]
}

/** Every agent, in the order the UI lists them. */
export function listAiAgents(): AiAgentDefinition[] {
  return AI_TASK_HOSTS.map((host) => AI_AGENTS[host])
}

/** The agents' own values, keyed by agent. */
export function mapAiAgents<T>(pick: (agent: AiAgentDefinition) => T): Record<AiTaskHost, T> {
  const result = {} as Record<AiTaskHost, T>
  for (const host of AI_TASK_HOSTS) result[host] = pick(AI_AGENTS[host])
  return result
}
