import { Notice, mockApp, mockLeaf } from 'obsidian';
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab';

type MutableSettingTab = TaskChuteSettingTab & {
  app: typeof mockApp;
  plugin: {
    settings: {
      customSections?: Array<{ hour: number; minute: number }>;
      slotKeys: Record<string, string>;
    };
    saveSettings: jest.Mock<Promise<void>, []>;
  };
  renderSectionCustomization: (container: HTMLElement) => void;
  applySectionCustomization: (
    boundaries: Array<{ hour: number; minute: number }> | undefined,
  ) => Promise<void>;
};

function createTab(): MutableSettingTab {
  const tab = Object.create(TaskChuteSettingTab.prototype) as MutableSettingTab;
  tab.app = mockApp;
  tab.plugin = {
    settings: {
      slotKeys: {},
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
  };
  return tab;
}

describe('TaskChuteSettingTab section customization', () => {
  beforeEach(() => {
    (Notice as jest.Mock).mockClear();
    const container = mockLeaf.containerEl.children[1] as { empty?: () => void };
    container.empty?.();
  });

  test('restores the latest draft value when input becomes invalid', () => {
    const tab = createTab();
    const container = mockLeaf.containerEl.children[1] as HTMLElement & {
      querySelector: (selector: string) => HTMLInputElement | null;
    };

    tab.renderSectionCustomization(container);

    const input = container.querySelector('.taskchute-boundary-input');
    expect(input).not.toBeNull();

    if (!input) {
      return;
    }

    input.value = '01:30';
    input.dispatchEvent(new Event('change'));
    expect(input.value).toBe('01:30');

    input.value = '99:99';
    input.dispatchEvent(new Event('change'));

    expect(input.value).toBe('01:30');
    expect(Notice).toHaveBeenCalledTimes(1);
  });

  test('re-renders boundary rows after apply-triggered sorting', () => {
    const tab = createTab();
    const container = mockLeaf.containerEl.children[1] as HTMLElement & {
      querySelector: (selector: string) => HTMLInputElement | HTMLButtonElement | null;
    };

    tab.renderSectionCustomization(container);

    const firstInput = container.querySelector('.taskchute-boundary-input');
    expect(firstInput).not.toBeNull();

    if (!firstInput) {
      return;
    }

    firstInput.value = '10:00';
    firstInput.dispatchEvent(new Event('change'));

    const applyButton = container.querySelector('.mod-cta');
    expect(applyButton).not.toBeNull();

    applyButton?.dispatchEvent(new Event('click'));

    const updatedFirstInput = container.querySelector('.taskchute-boundary-input');
    expect(updatedFirstInput?.value).toBe('08:00');
  });

  test('migrates invalid slotKeys to new boundaries instead of deleting them', async () => {
    const tab = createTab();
    tab.plugin.settings.slotKeys = {
      taskA: '8:00-12:00',
      taskB: '16:00-0:00',
      taskC: 'none',
    };

    await tab.applySectionCustomization([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 18, minute: 0 },
    ]);

    expect(tab.plugin.settings.slotKeys).toEqual({
      taskA: '6:00-12:00',
      taskB: '12:00-18:00',
      taskC: 'none',
    });
    expect(tab.plugin.saveSettings).toHaveBeenCalled();
  });
});
