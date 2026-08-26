import { mockApp } from 'obsidian';
import { applySectionCustomization } from '../../src/settings/services/sectionCustomizationService';
import type { PluginWithSettings } from '../../src/settings/pluginWithSettings';

function createPlugin(slotKeys: Record<string, string>) {
  return {
    app: mockApp,
    settings: { slotKeys },
    saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  } as unknown as PluginWithSettings & {
    settings: { slotKeys: Record<string, string> };
    saveSettings: jest.Mock<Promise<void>, []>;
  };
}

describe('applySectionCustomization', () => {
  test('migrates invalid slotKeys to new boundaries instead of deleting them', async () => {
    const plugin = createPlugin({
      taskA: '8:00-12:00',
      taskB: '16:00-0:00',
      taskC: 'none',
    });

    await applySectionCustomization(plugin, [
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 18, minute: 0 },
    ]);

    expect(plugin.settings.slotKeys).toEqual({
      taskA: '6:00-12:00',
      taskB: '12:00-18:00',
      taskC: 'none',
    });
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});
