import { createCommandRegistrar } from '../../src/commands/registerTaskCommands';
import type { CommandRegistrar, CommandHost } from '../../src/commands/types';
import type { App, Command } from 'obsidian';
import type { TaskChuteViewController } from '../../src/app/taskchute/TaskChuteViewController';
import { initializeLocaleManager } from '../../src/i18n';

describe('CommandRegistrar', () => {
  const viewControllerMock: jest.Mocked<TaskChuteViewController> = {
    activateView: jest.fn(async () => {}),
    getView: jest.fn(() => null),
    getOrCreateView: jest.fn(async () => null),
    triggerShowTodayTasks: jest.fn(async () => {}),
    triggerDuplicateSelectedTask: jest.fn(async () => {}),
    triggerDeleteSelectedTask: jest.fn(async () => {}),
    triggerResetSelectedTask: jest.fn(async () => {}),
    reorganizeIdleTasks: jest.fn(() => {}),
    applyLocaleToActiveView: jest.fn(() => {}),
  } as unknown as jest.Mocked<TaskChuteViewController>;

  const addCommand = jest.fn((command: Command) => command);
  const removeCommand = jest.fn();
  const showSettingsModal = jest.fn();

  const appMock = { commands: { removeCommand } } as unknown as App;

  const hostMock: CommandHost = {
    manifest: { id: 'taskchute-plus' },
    addCommand,
    app: appMock,
    showSettingsModal,
  } as CommandHost;

  beforeEach(() => {
    jest.clearAllMocks();
    initializeLocaleManager('en');
  });

  it('registers expected commands', async () => {
    const registrar: CommandRegistrar = createCommandRegistrar(hostMock, viewControllerMock);
    registrar.initialize();

    expect(addCommand).toHaveBeenCalledTimes(7);
    const ids = addCommand.mock.calls.map(([definition]) => definition.id);
    expect(ids).toEqual([
      'open-taskchute-view',
      'taskchute-settings',
      'duplicate-selected-task',
      'delete-selected-task',
      'reset-selected-task',
      'show-today-tasks',
      'reorganize-idle-tasks',
    ]);

    const openView = addCommand.mock.calls[0][0];
    await openView.callback();
    expect(viewControllerMock.activateView).toHaveBeenCalled();

    const settings = addCommand.mock.calls[1][0];
    await settings.callback();
    expect(showSettingsModal).toHaveBeenCalled();

    const duplicate = addCommand.mock.calls[2][0];
    await duplicate.callback();
    expect(viewControllerMock.triggerDuplicateSelectedTask).toHaveBeenCalled();

    const remove = addCommand.mock.calls[3][0];
    await remove.callback();
    expect(viewControllerMock.triggerDeleteSelectedTask).toHaveBeenCalled();

    const reset = addCommand.mock.calls[4][0];
    await reset.callback();
    expect(viewControllerMock.triggerResetSelectedTask).toHaveBeenCalled();

    const showToday = addCommand.mock.calls[5][0];
    await showToday.callback();
    expect(viewControllerMock.triggerShowTodayTasks).toHaveBeenCalled();

    const reorganize = addCommand.mock.calls[6][0];
    await reorganize.callback();
    expect(viewControllerMock.reorganizeIdleTasks).toHaveBeenCalled();
  });

  it('relocalizes commands on request', () => {
    const registrar: CommandRegistrar = createCommandRegistrar(hostMock, viewControllerMock);
    registrar.initialize();
    jest.clearAllMocks();

    registrar.relocalize();

    expect(removeCommand).toHaveBeenCalledTimes(7);
    expect(addCommand).toHaveBeenCalledTimes(7);
  });
});
