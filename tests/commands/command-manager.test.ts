import { createCommandRegistrar } from '../../src/commands/registerTaskCommands';
import type { CommandRegistrar, CommandHost } from '../../src/types/Commands';
import type { Command } from 'obsidian';
import type { TaskChuteViewController } from '../../src/app/taskchute/TaskChuteViewController';
import { setObsidianLanguage } from '../utils/locale';

describe('CommandRegistrar', () => {
  const viewControllerMock: jest.Mocked<TaskChuteViewController> = {
    activateView: jest.fn(async () => {}),
    isViewActive: jest.fn(() => true),
    getView: jest.fn(() => null),
    getOrCreateView: jest.fn(async () => null),
    triggerShowTodayTasks: jest.fn(async () => {}),
    triggerDuplicateSelectedTask: jest.fn(async () => {}),
    triggerDeleteSelectedTask: jest.fn(async () => {}),
    triggerResetSelectedTask: jest.fn(async () => {}),
    reorganizeIdleTasks: jest.fn(() => {}),
  } as unknown as jest.Mocked<TaskChuteViewController>;

  const addCommand = jest.fn((command: Command) => command);
  const showSettingsModal = jest.fn();

  const hostMock: CommandHost = {
    addCommand,
    showSettingsModal,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setObsidianLanguage('en');
  });

  it('registers expected commands', async () => {
    const registrar: CommandRegistrar = createCommandRegistrar(hostMock, viewControllerMock);
    registrar.initialize();

    expect(addCommand).toHaveBeenCalledTimes(7);
    const ids = addCommand.mock.calls.map(([definition]) => definition.id);
    expect(ids).toEqual([
      'open-taskchute-view',
      'taskchute-settings',
      'show-today-tasks',
      'reorganize-idle-tasks',
      'duplicate-selected-task',
      'delete-selected-task',
      'reset-selected-task',
    ]);

    const openView = addCommand.mock.calls[0][0];
    await openView.callback?.();
    expect(viewControllerMock.activateView).toHaveBeenCalled();

    const settings = addCommand.mock.calls[1][0];
    await settings.callback?.();
    expect(showSettingsModal).toHaveBeenCalled();

    const showToday = addCommand.mock.calls[2][0];
    await showToday.callback?.();
    expect(viewControllerMock.triggerShowTodayTasks).toHaveBeenCalled();

    const reorganize = addCommand.mock.calls[3][0];
    await reorganize.callback?.();
    expect(viewControllerMock.reorganizeIdleTasks).toHaveBeenCalled();

    const duplicate = addCommand.mock.calls[4][0];
    duplicate.checkCallback?.(false);
    expect(viewControllerMock.triggerDuplicateSelectedTask).toHaveBeenCalled();

    const remove = addCommand.mock.calls[5][0];
    remove.checkCallback?.(false);
    expect(viewControllerMock.triggerDeleteSelectedTask).toHaveBeenCalled();

    const reset = addCommand.mock.calls[6][0];
    reset.checkCallback?.(false);
    expect(viewControllerMock.triggerResetSelectedTask).toHaveBeenCalled();
  });
});
