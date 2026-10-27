import type { AiRunExitOutcome } from './dispatchers/Dispatcher'

/**
 * Refusals that come from the broker's own machinery rather than from the
 * request (LEV-405). A new broker may well not have them: it starts from the
 * Node.js and the release on disk now. An invalid or unsupported request
 * fails the same way in any broker, so it is not here.
 *
 * Messages, not codes, because brokers already running in the field only
 * send messages: "Terminal root ownership identity could not be recorded" is
 * what a broker whose Node.js was removed by an upgrade says (LEV-400).
 */
const BROKER_MACHINERY_FAILURES = [
  'Terminal process owner watchdog is unavailable',
  'Node.js was not found:',
  'Terminal process ownership tracking could not be initialized',
  'Terminal process ownership hooks could not be initialized',
  'Terminal root ownership identity could not be recorded',
  'Terminal session process could not be started with ',
]

/** Whether starting over with a new broker could get this session started. */
export function isBrokerMachineryFailure(
  outcome: Pick<AiRunExitOutcome, 'terminalFailure' | 'errorMessage'>,
): boolean {
  if (outcome.terminalFailure !== 'broker-refused') return false
  const message = outcome.errorMessage ?? ''
  return BROKER_MACHINERY_FAILURES.some((prefix) => message.startsWith(prefix))
}
