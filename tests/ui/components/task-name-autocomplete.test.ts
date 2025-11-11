import { TaskNameAutocomplete } from '../../../src/ui/components/TaskNameAutocomplete'
import type { Plugin } from 'obsidian'

describe('TaskNameAutocomplete popout scroll handling', () => {
  test('handleWindowScroll respects injected Node constructor', () => {
    const pluginStub = { app: {} } as Plugin
    const inputEl = document.createElement('input')
    const containerEl = document.createElement('div')

    class PopoutNode {}
    const popoutWindow = {
      Node: PopoutNode as unknown as typeof Node,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    } as unknown as Window & typeof globalThis

    const autocomplete = new TaskNameAutocomplete(
      pluginStub,
      inputEl,
      containerEl,
      { doc: document, win: popoutWindow },
    )

    const hideSpy = jest.fn()
    ;(autocomplete as unknown as { hideSuggestions: () => void }).hideSuggestions = hideSpy

    const containsMock = jest.fn().mockReturnValue(true)
    ;(autocomplete as { suggestionsElement?: HTMLElement }).suggestionsElement = {
      contains: containsMock,
    } as unknown as HTMLElement

    const eventTarget = new PopoutNode() as unknown as Node
    const event = { target: eventTarget } as Event
    ;(autocomplete as unknown as { handleWindowScroll: (event: Event) => void }).handleWindowScroll(event)

    expect(containsMock).toHaveBeenCalledWith(eventTarget)
    expect(hideSpy).not.toHaveBeenCalled()
  })
})
