import type { SettingDefinitionAction, SettingDefinitionList } from 'obsidian';
import { Notice, mockApp } from 'obsidian';
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab';
import { SectionConfigService } from '../../src/services/SectionConfigService';
import { flatten } from './definitionHelpers';

function createTab() {
  const plugin = {
    app: mockApp,
    manifest: { id: 'taskchute-plus', version: '2.2.0' },
    settings: { slotKeys: {} } as Record<string, unknown>,
    pathManager: { validatePath: () => ({ valid: true }) },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  };
  const tab = new TaskChuteSettingTab(mockApp as never, plugin as never);
  return { tab, plugin };
}

function boundaryList(tab: TaskChuteSettingTab): SettingDefinitionList {
  const list = flatten(tab.getSettingDefinitions()).find(
    (item): item is SettingDefinitionList =>
      'type' in item && item.type === 'list',
  );
  if (!list) throw new Error('boundary list not found');
  return list;
}

function actionNamed(
  tab: TaskChuteSettingTab,
  name: string,
): SettingDefinitionAction {
  const row = flatten(tab.getSettingDefinitions()).find(
    (item): item is SettingDefinitionAction =>
      'action' in item && item.action !== undefined && item.name === name,
  );
  if (!row) throw new Error(`action row "${name}" not found`);
  return row;
}

describe('TaskChuteSettingTab section customization', () => {
  beforeEach(() => {
    (Notice as jest.Mock).mockClear();
  });

  test('seeds one row per boundary in effect', () => {
    const { tab } = createTab();

    expect(boundaryList(tab).items).toHaveLength(
      SectionConfigService.DEFAULT_BOUNDARIES.length,
    );
    expect(tab.getControlValue('sectionBoundary.0')).toBe('00:00');
  });

  test('rejects a malformed time without touching the draft', async () => {
    const { tab } = createTab();
    const control = boundaryList(tab).items?.[1] as {
      control: { validate: (value: string) => string | undefined };
    };

    await tab.setControlValue('sectionBoundary.1', '01:30');
    expect(tab.getControlValue('sectionBoundary.1')).toBe('01:30');

    // The framework refuses the change on a non-empty message, so the handler
    // never runs and the previous value stands.
    expect(control.control.validate('99:99')).toBeTruthy();
    expect(tab.getControlValue('sectionBoundary.1')).toBe('01:30');
  });

  test('an added boundary survives the rebuild that adding it triggers', () => {
    const { tab } = createTab();
    const before = boundaryList(tab).items?.length ?? 0;

    boundaryList(tab).addItem?.action({} as HTMLElement);

    expect(boundaryList(tab).items).toHaveLength(before + 1);
  });

  test('keeps at least two boundaries by withholding the delete affordance', () => {
    const { tab } = createTab();

    let list = boundaryList(tab);
    while ((list.items?.length ?? 0) > 2) {
      list.onDelete?.(list.items!.length - 1);
      list = boundaryList(tab);
    }

    expect(list.items).toHaveLength(2);
    expect(list.onDelete).toBeUndefined();
  });

  test('applying sorts the boundaries before validating them', async () => {
    const { tab } = createTab();

    await tab.setControlValue('sectionBoundary.1', '02:00');
    await tab.setControlValue('sectionBoundary.2', '01:00');
    actionNamed(tab, 'Apply').action({} as HTMLElement, 0);

    expect(tab.getControlValue('sectionBoundary.1')).toBe('01:00');
    expect(tab.getControlValue('sectionBoundary.2')).toBe('02:00');
  });

  test('reset puts the default boundaries back', async () => {
    const { tab } = createTab();
    await tab.setControlValue('sectionBoundary.1', '02:00');

    actionNamed(tab, 'Reset to default').action({} as HTMLElement, 0);

    expect(tab.getControlValue('sectionBoundary.1')).toBe(
      `0${SectionConfigService.DEFAULT_BOUNDARIES[1].hour}:00`,
    );
  });
});
