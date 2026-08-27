/**
 * Structural invariants over the whole definition tree.
 *
 * The declarative API binds controls to keys by string, and every read and
 * write is dispatched through the tab's handler map. A typo in either half is
 * silent at runtime — the control falls through to the base implementation and
 * writes a raw value into settings — so it is worth one cheap test that walks
 * the tree and checks the two halves still line up.
 */
import { mockApp } from 'obsidian'
import type { SettingDefinitionItem } from 'obsidian'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'
import { DEFAULT_SETTINGS } from '../../src/settings/defaults'
import { flatten } from './definitionHelpers'

function createTab(): TaskChuteSettingTab {
  const plugin = {
    app: mockApp,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: { ...DEFAULT_SETTINGS },
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  }
  return new TaskChuteSettingTab(mockApp as never, plugin as never)
}

function controls(items: SettingDefinitionItem[]) {
  return flatten(items).filter(
    (item): item is Extract<SettingDefinitionItem, { control: unknown }> =>
      'control' in item && item.control !== undefined,
  )
}

describe('setting definitions', () => {
  test('every control key resolves to a registered handler', () => {
    const tab = createTab()
    const unhandled = controls(tab.getSettingDefinitions())
      .map((item) => item.control.key)
      // A handled key always resolves to a value — every handler falls back to
      // a default. A mistyped one drops through to the base implementation,
      // which reads settings[key] and finds nothing.
      .filter((key) => tab.getControlValue(key) === undefined)

    expect(unhandled).toEqual([])
  })

  test('no key is bound by two controls', () => {
    const keys = controls(createTab().getSettingDefinitions()).map(
      (item) => item.control.key,
    )

    expect(keys).toEqual([...new Set(keys)])
  })

  test('every definition carries a name for search', () => {
    const nameless = flatten(createTab().getSettingDefinitions()).filter(
      (item) =>
        !('type' in item) && (!('name' in item) || !String(item.name).trim()),
    )

    expect(nameless).toEqual([])
  })

  test('every visibility predicate evaluates without throwing', () => {
    const items = flatten(createTab().getSettingDefinitions())

    expect(() => {
      items.forEach((item) => {
        const visible = (item as { visible?: boolean | (() => boolean) }).visible
        if (typeof visible === 'function') visible()
      })
    }).not.toThrow()
  })
})
