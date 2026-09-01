import TaskListRenderer, { TaskListRendererHost } from '../../../src/ui/tasklist/TaskListRenderer';
import { TaskData, TaskInstance } from '../../../src/types';

// JSDOM lacks DragEvent; provide a minimal polyfill
if (typeof globalThis.DragEvent === 'undefined') {
  (globalThis as Record<string, unknown>).DragEvent = class DragEvent extends Event {
    readonly dataTransfer: DataTransfer | null;
    constructor(type: string, init?: EventInit & { dataTransfer?: DataTransfer | null }) {
      super(type, init);
      this.dataTransfer = init?.dataTransfer ?? null;
    }
  };
}

describe('TaskListRenderer', () => {
  function attachCreateEl(target: HTMLElement): void {
    const typed = target;
    typed.createEl = (function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
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
    }) as unknown as HTMLElement['createEl'];
    typed.createSvg = (function (this: HTMLElement, tag: string, options: { attr?: Record<string, string>; cls?: string } = {}) {
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
      return svg;
    }) as unknown as HTMLElement['createSvg'];
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
      showReminderSettingsModal: jest.fn(),
      isCollapsibleEnabled: () => false,
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

  test('the row keeps its text in one column and its controls beside it', () => {
    const idleInst = createInstance({ instanceId: 'idle-1' });
    const { taskList, renderer } = createHost([idleInst]);

    renderer.render();

    const item = taskList.querySelector('.task-item') as HTMLElement;
    const main = item.querySelector('.task-item__main') as HTMLElement;
    expect(main).toBeTruthy();

    // Name, project and clock stack together on a phone, so they share one
    // flex column; the controls set the row's height and stay outside it.
    expect(main.querySelector('.task-name-container')).toBeTruthy();
    expect(main.querySelector('.taskchute-project-display')).toBeTruthy();
    expect(main.querySelector('.task-time-range')).toBeTruthy();
    expect(
      Array.from(item.children).map((el) => el.className.split(' ')[0]),
    ).toEqual([
      'drag-handle',
      'play-stop-button',
      'task-item__main',
      'comment-button',
      'routine-button',
      'settings-task-button',
    ]);

    // The row is flex now, so an idle task simply renders no duration -- the
    // empty span that used to hold a grid track open is gone.
    expect(item.querySelector('.task-duration-placeholder')).toBeNull();
  });

  test('render registers managed handlers for drag and context interactions', () => {
    const instance = createInstance();
    const { renderer, registerManagedDomEvent, host } = createHost([instance]);

    renderer.render();

    expect(registerManagedDomEvent).toHaveBeenCalled();
    const events = registerManagedDomEvent.mock.calls.map(([, event]) => event);
    // Reordering runs on Pointer Events now, so the grip -- not the row -- is
    // where the drag listeners live; rows are hit-tested instead of listened to.
    expect(events).toEqual(
      expect.arrayContaining([
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'contextmenu',
        'click',
      ]),
    );
    expect(events).not.toContain('dragstart');

    const taskItem = host.taskList.querySelector('.task-item') as HTMLElement;
    expect(taskItem).toBeTruthy();
  });

  describe('pointer drag', () => {
    function stubRect(el: HTMLElement, rect: { top: number; height: number; width?: number }): void {
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top: rect.top,
          bottom: rect.top + rect.height,
          left: 0,
          right: rect.width ?? 600,
          width: rect.width ?? 600,
          height: rect.height,
        }),
      });
    }

    function pointer(type: string, clientX: number, clientY: number): PointerEvent {
      return new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId: 1,
        isPrimary: true,
      });
    }

    test('the grip carries no draggable attribute -- iPadOS never fires dragstart', () => {
      const { taskList, renderer } = createHost([createInstance()]);

      renderer.render();

      const taskItem = taskList.querySelector('.task-item') as HTMLElement;
      expect(taskItem.hasAttribute('draggable')).toBe(false);
      expect(taskList.querySelector('.drag-handle')?.hasAttribute('draggable')).toBe(false);
    });

    test('a press that never moves stays a tap and leaves the row alone', () => {
      const { taskList, renderer } = createHost([createInstance()]);

      renderer.render();

      const taskItem = taskList.querySelector('.task-item') as HTMLElement;
      const dragHandle = taskItem.querySelector('.drag-handle') as HTMLElement;
      stubRect(taskItem, { top: 40, height: 32 });

      dragHandle.dispatchEvent(pointer('pointerdown', 10, 50));
      dragHandle.dispatchEvent(pointer('pointermove', 11, 51));
      dragHandle.dispatchEvent(pointer('pointerup', 11, 51));

      expect(taskItem.classList.contains('dragging')).toBe(false);
      expect(document.querySelector('.task-item-drag-ghost')).toBeNull();
    });

    test('dragging the grip fades the row and floats a clone under the pointer', () => {
      const { taskList, renderer } = createHost([createInstance()]);

      renderer.render();

      const taskItem = taskList.querySelector('.task-item') as HTMLElement;
      const dragHandle = taskItem.querySelector('.drag-handle') as HTMLElement;
      stubRect(taskList, { top: 0, height: 400 });
      stubRect(taskItem, { top: 40, height: 32 });

      dragHandle.dispatchEvent(pointer('pointerdown', 10, 50));
      dragHandle.dispatchEvent(pointer('pointermove', 10, 90));

      expect(taskItem.classList.contains('dragging')).toBe(true);
      const ghost = document.querySelector('.task-item-drag-ghost') as HTMLElement;
      expect(ghost).toBeTruthy();
      expect(ghost).not.toBe(taskItem);
      // Anchored where the grip was grabbed: 40px down from the row's top.
      expect(ghost.classList.contains('task-item-drag-ghost--floating')).toBe(true);
      expect(ghost.style.transform).toBe('translate3d(0px, 80px, 0)');

      dragHandle.dispatchEvent(pointer('pointerup', 10, 90));

      expect(taskItem.classList.contains('dragging')).toBe(false);
      expect(document.querySelector('.task-item-drag-ghost')).toBeNull();
    });

    test('a cancelled pointer drops nothing and cleans up', () => {
      const { taskList, renderer, host } = createHost([createInstance()]);

      renderer.render();

      const taskItem = taskList.querySelector('.task-item') as HTMLElement;
      const dragHandle = taskItem.querySelector('.drag-handle') as HTMLElement;
      stubRect(taskList, { top: 0, height: 400 });
      stubRect(taskItem, { top: 40, height: 32 });

      dragHandle.dispatchEvent(pointer('pointerdown', 10, 50));
      dragHandle.dispatchEvent(pointer('pointermove', 10, 90));
      dragHandle.dispatchEvent(pointer('pointercancel', 10, 90));

      expect(host.handleDrop).not.toHaveBeenCalled();
      expect(taskItem.classList.contains('dragging')).toBe(false);
      expect(document.querySelector('.task-item-drag-ghost')).toBeNull();
    });

    test('dropping on another row hands the drop the payload and the pointer position', () => {
      const first = createInstance();
      const second = createInstance({ instanceId: 'instance-2', order: 1 });
      const { taskList, renderer, host } = createHost([first, second]);

      renderer.render();

      const rows = Array.from(taskList.querySelectorAll<HTMLElement>('.task-item'));
      const dragHandle = rows[0].querySelector('.drag-handle') as HTMLElement;
      stubRect(taskList, { top: 0, height: 400 });
      stubRect(rows[0], { top: 40, height: 32 });
      stubRect(rows[1], { top: 72, height: 32 });

      // The row under the pointer is resolved by hit-testing, not by listeners.
      const elementFromPoint = jest
        .spyOn(document, 'elementFromPoint')
        .mockReturnValue(rows[1]);
      try {
        dragHandle.dispatchEvent(pointer('pointerdown', 10, 50));
        dragHandle.dispatchEvent(pointer('pointermove', 10, 95));
        dragHandle.dispatchEvent(pointer('pointerup', 10, 95));
      } finally {
        elementFromPoint.mockRestore();
      }

      expect(host.handleDrop).toHaveBeenCalledTimes(1);
      const [point, target, inst, payload] = (host.handleDrop as jest.Mock).mock.calls[0];
      expect(point).toEqual({ clientY: 95 });
      expect(target).toBe(rows[1]);
      expect(inst).toBe(second);
      expect(payload).toBe('8:00-12:00::0::instance-1');
    });

    test('completed rows are not draggable', () => {
      const done = createInstance({
        instanceId: 'done-1',
        state: 'done',
        startTime: new Date(2025, 0, 1, 13, 0),
        stopTime: new Date(2025, 0, 1, 14, 15),
      });
      const { taskList, renderer } = createHost([done]);

      renderer.render();

      const taskItem = taskList.querySelector('.task-item') as HTMLElement;
      const dragHandle = taskList.querySelector('.drag-handle') as HTMLElement;
      expect(dragHandle.classList.contains('disabled')).toBe(true);

      dragHandle.dispatchEvent(pointer('pointerdown', 10, 50));
      dragHandle.dispatchEvent(pointer('pointermove', 10, 90));

      expect(taskItem.classList.contains('dragging')).toBe(false);
    });
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

  test('does not render recipe badge when recipe feature is disabled', () => {
    const instance = createInstance({
      task: {
        name: 'Recipe task',
        path: 'TASKS/recipe.md',
        recipePath: 'TaskChute/Recipes/Gym.md',
        isRoutine: false,
      } as TaskData,
    });
    const { host, taskList } = createHost([instance]);
    host.getRecipeProgressSummary = jest.fn(async () => ({ total: 1, checked: 0 }));
    host.showRecipeRunPopover = jest.fn();
    host.isRecipeFeatureEnabled = () => false;
    const renderer = new TaskListRenderer(host);

    renderer.render();

    expect(taskList.querySelector('.recipe-task-badge')).toBeNull();
  });

  test('dragleave on slot header resets isDragging so click still works', () => {
    const inst = createInstance({ instanceId: 'drag-1', slotKey: '8:00-12:00' });
    const { host, renderer, taskList } = createHost([inst]);
    host.isCollapsibleEnabled = () => true;

    renderer.render();

    // Find the 8:00-12:00 slot header
    const headers = Array.from(taskList.querySelectorAll('.time-slot-header.tc-collapsible'));
    const slotHeader = headers.find((h) => h.textContent?.includes('8:00-12:00')) as HTMLElement;
    expect(slotHeader).toBeTruthy();

    // Simulate: dragover (sets isDragging=true) → dragleave (should reset)
    slotHeader.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
    slotHeader.dispatchEvent(new Event('dragleave'));

    // Now click should still toggle collapse (isDragging should be false)
    slotHeader.click();

    // If isDragging was properly reset, click should have collapsed the slot
    // Re-render would remove the task items under that slot
    const items = taskList.querySelectorAll('[data-slot="8:00-12:00"]');
    expect(items).toHaveLength(0);
  });

  test('collapsed state is scoped per date and does not leak across days', () => {
    const inst = createInstance({ instanceId: 'scope-1', slotKey: '8:00-12:00' });
    const { host, renderer, taskList } = createHost([inst]);
    host.isCollapsibleEnabled = () => true;

    // Render for March 10 and collapse the 8:00-12:00 slot
    host.currentDate = new Date(2026, 2, 10);
    renderer.render();
    const getSlotHeader = () => {
      const headers = Array.from(taskList.querySelectorAll('.time-slot-header.tc-collapsible'));
      return headers.find((h) => h.textContent?.includes('8:00-12:00')) as HTMLElement;
    };
    getSlotHeader().click(); // collapse

    // Verify collapsed on March 10
    expect(taskList.querySelectorAll('[data-slot="8:00-12:00"]')).toHaveLength(0);

    // Switch to March 9 — slot should NOT be collapsed
    host.currentDate = new Date(2026, 2, 9);
    renderer.render();
    expect(taskList.querySelectorAll('[data-slot="8:00-12:00"]')).toHaveLength(1);

    // Switch back to March 10 — slot should still be collapsed
    host.currentDate = new Date(2026, 2, 10);
    renderer.render();
    expect(taskList.querySelectorAll('[data-slot="8:00-12:00"]')).toHaveLength(0);
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
