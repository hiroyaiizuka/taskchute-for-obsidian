import { isBrokerMachineryFailure } from '@/features/ai-task/services/BrokerRecovery'
import { terminalFailureNotice } from '@/features/ai-task/services/TerminalNotices'

describe('isBrokerMachineryFailure (LEV-405)', () => {
  test.each([
    'Terminal root ownership identity could not be recorded',
    'Terminal session process could not be started with /opt/homebrew/bin/node',
    'Node.js was not found: /opt/homebrew/Cellar/node/25.2.1/bin/node no longer exists and no node executable is on PATH',
    'Terminal process owner watchdog is unavailable',
    'Terminal process ownership tracking could not be initialized',
    'Terminal process ownership hooks could not be initialized',
  ])('a new broker may not repeat: %s', (errorMessage) => {
    expect(isBrokerMachineryFailure({ terminalFailure: 'broker-refused', errorMessage })).toBe(true)
  })

  test.each([
    'Invalid spawn request',
    'Terminal session was already terminated',
    'Ownership-disabling environment options or Python interpreter flags -E, -I, and -S are not supported because they disable safe descendant-process tracking',
  ])('any broker would refuse the request again: %s', (errorMessage) => {
    expect(isBrokerMachineryFailure({ terminalFailure: 'broker-refused', errorMessage })).toBe(false)
  })

  test('only a refusal by a running broker counts; one that never started has nothing to replace', () => {
    const errorMessage = 'Terminal root ownership identity could not be recorded'
    expect(isBrokerMachineryFailure({ terminalFailure: 'broker-start-failed', errorMessage })).toBe(false)
    expect(isBrokerMachineryFailure({ terminalFailure: 'node-not-found', errorMessage })).toBe(false)
    expect(isBrokerMachineryFailure({ errorMessage })).toBe(false)
  })

  test('the failed-start notice offers a restart only for those', () => {
    expect(
      terminalFailureNotice('broker-refused', 'Terminal root ownership identity could not be recorded')
        .restartable,
    ).toBe(true)
    expect(terminalFailureNotice('broker-refused', 'Invalid spawn request').restartable).toBeUndefined()
    expect(terminalFailureNotice('node-not-found', undefined).restartable).toBeUndefined()
  })
})
