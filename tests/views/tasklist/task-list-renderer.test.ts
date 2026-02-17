import TaskListRenderer, { TaskListRendererHost } from '../../../src/ui/tasklist/TaskListRenderer';
import { TaskData, TaskInstance } from '../../../src/types';

describe('TaskListRenderer', () => {
  function attachCreateEl(target: HTMLElement): void {
    const typed = target as HTMLElement & {
      createEl?: (tag: string, options?: Record<string, unknown>) => HTMLElement;
      createSvg?: (tag: string, options?: { attr?: Record<string, string>; cls?: string }) => SVGElement;
    };
    typed.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const el = document.createElement(tag);
      if (options.cls) {
        el.className = options.cls as string;
      }
      if (options.text) {
        el.textContent = options.text as string;
      }
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          el.setAttribute(key, value);
        });
      }
      attachCreateEl(el);
      this.appendChild(el);
      return el;
    };
    typed.createSvg = function (this: HTMLElement, tag: string, options: { attr?: Record<string, string>; cls?: string } = {}) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', tag);
      if (options.cls) {
        svg.setAttribute('class', options.cls);
      }
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          svg.setAttribute(key, value);
        });
      }
      attachCreateEl(svg as unknown as HTMLElement);
      this.appendChild(svg as unknown as HTMLElement);
      return svg as unknown as SVGElement;
    };
    (typed as HTMLElement & { empty?: () => void }).empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
    };
  }

  function createHost(instances: TaskInstance[] = []): {
    host: TaskListRendererHost;
    registerManagedDomEvent: jest.Mock;
    taskList: HTMLElement;
    renderer: TaskListRenderer;
  } {
    const taskList = document.createElement('div');
    attachCreateEl(taskList);

    const registerManagedDomEvent = jest.fn((target: HTMLElement | Document, event: string, handler: EventListener) => {
      target.addEventListener(event, handler);
    });

    const host: TaskListRendererHost = {
      taskList,
      taskInstances: instances,
      currentDate: new Date(2025, 0, 1),
      tv: (_key: string, fallback: string) => fallback,
      app: {
        workspace: {
          openLinkText: jest.fn(),
        },
      },
      applyResponsiveClasses: jest.fn(),
      sortTaskInstancesByTimeOrder: jest.fn(),
      getTimeSlotKeys: () => ['0:00-8:00', '8:00-12:00', '12:00-16:00', '16:00-0:00'],
      sortByOrder: (items: TaskInstance[]) => [...items],
      selectTaskForKeyboard: jest.fn(),
      registerManagedDomEvent,
      handleDragOver: jest.fn(),
      handleDrop: jest.fn(),
      handleSlotDrop: jest.fn(),
      startInstance: jest.fn(),
      stopInstance: jest.fn(),
      duplicateAndStartInstance: jest.fn(),
      showTaskCompletionModal: jest.fn(),
      hasCommentData: jest.fn(async () => false),
      showRoutineEditModal: jest.fn(),
      toggleRoutine: jest.fn(),
      showTaskSettingsTooltip: jest.fn(),
      showTaskContextMenu: jest.fn(),
      calculateCrossDayDuration: (start: Date, stop: Date) => stop.getTime() - start.getTime(),
      showStartTimePopup: jest.fn(),
      showStopTimePopup: jest.fn(),
      updateTotalTasksCount: jest.fn(),
      showProjectModal: jest.fn(),
      showUnifiedProjectModal: jest.fn(),
      openProjectInSplit: jest.fn(),
    };

    const renderer = new TaskListRenderer(host);
    return { host, registerManagedDomEvent, taskList, renderer };
  }

  function createInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
    return {
      task: {
        name: 'Sample Task',
        path: 'TASKS/sample.md',
        projectPath: 'PROJECTS/project.md',
        projectTitle: 'Project',
        isRoutine: false,
      },
      instanceId: 'instance-1',
      slotKey: '8:00-12:00',
      state: 'idle',
      ...overrides,
    } as TaskInstance;
  }

  test('render groups tasks and creates slot headers', () => {
    const idleInst = createInstance({ instanceId: 'idle-1', slotKey: 'none' });
    const runningInst = createInstance({ instanceId: 'run-1', slotKey: '8:00-12:00', state: 'running', startTime: new Date(2025, 0, 1, 9, 0, 0) });
    const doneInst = createInstance({ instanceId: 'done-1', slotKey: '12:00-16:00', state: 'done', startTime: new Date(2025, 0, 1, 13, 0), stopTime: new Date(2025, 0, 1, 14, 15) });
    const { taskList, renderer } = createHost([idleInst, runningInst, doneInst]);

    renderer.render();

    const headers = Array.from(taskList.querySelectorAll('.time-slot-header'));
    expect(headers.map((el) => el.textContent)).toContain('No time');
    const items = taskList.querySelectorAll('.task-item');
    expect(items).toHaveLength(3);
    expect(taskList.querySelector('[data-instance-id="run-1"] .task-timer-display')).toBeTruthy();
    const duration = taskList.querySelector('[data-instance-id="done-1"] .task-duration');
    expect(duration?.textContent).toBe('01:15');
  });

  test('render registers managed handlers for drag and context interactions', () => {
    const instance = createInstance();
    const { renderer, registerManagedDomEvent, host } = createHost([instance]);

    renderer.render();

    expect(registerManagedDomEvent).toHaveBeenCalled();
    const events = registerManagedDomEvent.mock.calls.map(([, event]) => event);
    expect(events).toEqual(expect.arrayContaining(['dragover', 'dragleave', 'drop', 'contextmenu', 'click', 'dragstart', 'dragend']));

    const taskItem = host.taskList.querySelector('.task-item') as HTMLElement;
    expect(taskItem).toBeTruthy();
  });

  test('updateTimerDisplay formats elapsed running time', () => {
    const runningInst = createInstance({
      instanceId: 'run-2',
      state: 'running',
      startTime: new Date(Date.now() - 135000), // 2m15s ago
    });
    const { renderer } = createHost([runningInst]);
    const timerEl = document.createElement('span');

    renderer.updateTimerDisplay(timerEl, runningInst);

    expect(timerEl.textContent).toMatch(/00:0[12]:[0-5]\d/);
  });

  test('project button renders icon and unified modal trigger', () => {
    const assigned = createInstance({
      instanceId: 'proj-1',
      slotKey: '8:00-12:00',
      task: {
        name: 'Sample Task',
        path: 'TASKS/sample.md',
        projectPath: 'PROJECTS/sample.md',
        projectTitle: 'Project - Sample',
        isRoutine: false,
      } as TaskData,
    });
    const { host, renderer } = createHost([assigned]);

    renderer.render();

    const button = host.taskList.querySelector('.taskchute-project-button');
    expect(button).toBeTruthy();
    button?.dispatchEvent(new Event('click'));
    expect(host.showUnifiedProjectModal).toHaveBeenCalledWith(assigned);

    const projectName = host.taskList.querySelector('.taskchute-project-name');
    expect(projectName?.textContent).toBe('Sample');

    const link = host.taskList.querySelector('.taskchute-external-link');
    expect(link).toBeTruthy();
    link?.dispatchEvent(new Event('click'));
    expect(host.openProjectInSplit).toHaveBeenCalledWith('PROJECTS/sample.md');
  });

  test('project placeholder calls showProjectModal when unset', () => {
    const unassigned = createInstance({
      task: {
        name: 'Detached',
        path: 'TASKS/detached.md',
        projectPath: undefined,
        projectTitle: undefined,
        isRoutine: false,
      } as TaskData,
      slotKey: 'none',
    });
    const { host, renderer } = createHost([unassigned]);

    renderer.render();

    const placeholder = host.taskList.querySelector('.taskchute-project-placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.textContent).toBe('Set project');
    placeholder?.dispatchEvent(new Event('click'));
    expect(host.showProjectModal).toHaveBeenCalledWith(unassigned);
  });

  test('routine button is inactive when routine is disabled', () => {
    const disabledRoutine = createInstance({
      task: {
        name: 'Disabled Routine',
        path: 'TASKS/disabled-routine.md',
        projectPath: undefined,
        projectTitle: undefined,
        isRoutine: true,
        routine_enabled: false,
      } as TaskData,
    });
    const { host, renderer } = createHost([disabledRoutine]);

    renderer.render();

    const button = host.taskList.querySelector('.routine-button');
    expect(button).not.toBeNull();
    expect(button?.classList.contains('active')).toBe(false);
  });

  test('routine button is active when routine is enabled', () => {
    const enabledRoutine = createInstance({
      task: {
        name: 'Enabled Routine',
        path: 'TASKS/enabled-routine.md',
        projectPath: undefined,
        projectTitle: undefined,
        isRoutine: true,
        routine_enabled: true,
      } as TaskData,
    });
    const { host, renderer } = createHost([enabledRoutine]);

    renderer.render();

    const button = host.taskList.querySelector('.routine-button');
    expect(button).not.toBeNull();
    expect(button?.classList.contains('active')).toBe(true);
  });
});
