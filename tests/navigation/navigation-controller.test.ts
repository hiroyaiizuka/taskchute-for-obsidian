import NavigationController from '../../src/ui/navigation/NavigationController';

type CreateEl = (tag: string, options?: Record<string, unknown>) => HTMLElement;

type NavigationViewStub = {
  tv: (key: string, fallback: string) => string;
  app: {
    setting: {
      open: jest.Mock<void, []>;
      openTabById: jest.Mock<void, [string]>;
    };
    vault: {
      getMarkdownFiles: jest.Mock<unknown[], []>;
    };
    metadataCache: {
      getFileCache: jest.Mock<unknown, [unknown]>;
    };
  };
  plugin: {
    manifest: { id: string };
    pathManager: { getTaskFolderPath: () => string };
  };
  navigationState: { selectedSection: string | null; isOpen: boolean };
  registerManagedDomEvent: jest.Mock<void, [HTMLElement, string, EventListener]>;
  reloadTasksAndRestore: jest.Mock;
  showRoutineEditModal: jest.Mock;
  getWeekdayNames: () => string[];
  getCurrentDateString: () => string;
  leaf: unknown;
  navigationOverlay?: HTMLElement;
  navigationPanel?: HTMLElement;
  navigationContent?: HTMLElement;
};

describe('NavigationController', () => {
  function attachCreateEl(target: HTMLElement): void {
    const typed = target as HTMLElement & { createEl?: CreateEl };
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
  }

  function createController() {
    const registerManagedDomEvent: NavigationViewStub['registerManagedDomEvent'] = jest.fn(
      (target, event, handler) => {
        target.addEventListener(event, handler);
      },
    );

    const view: NavigationViewStub = {
      tv: jest.fn((_, fallback) => fallback),
      app: {
        setting: {
          open: jest.fn(),
          openTabById: jest.fn(),
        },
        vault: {
          getMarkdownFiles: jest.fn(() => []),
        },
        metadataCache: {
          getFileCache: jest.fn(() => undefined),
        },
        fileManager: {
          processFrontMatter: jest.fn(async (_file, updater) => {
            updater({});
          }),
        },
      },
      plugin: {
        manifest: { id: 'taskchute-plus' },
        app: undefined,
        pathManager: {
          getTaskFolderPath: () => 'TASKS',
          getLogDataPath: () => 'LOGS',
          getReviewDataPath: () => 'REVIEWS',
          ensureFolderExists: jest.fn(),
        },
      },
      navigationState: { selectedSection: null, isOpen: false },
      registerManagedDomEvent,
      reloadTasksAndRestore: jest.fn(),
      showRoutineEditModal: jest.fn(),
      getWeekdayNames: () => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      getCurrentDateString: () => '2025-10-09',
      leaf: {},
    };

    view.plugin.app = view.app as unknown; // align plugin/app linkage for controllers
    const controller = new NavigationController(view);
    return { controller, view, registerManagedDomEvent };
  }

  test('createNavigationUI wires nav items and managed handlers', async () => {
    const { controller, view, registerManagedDomEvent } = createController();
    const container = document.createElement('div');
    attachCreateEl(container);

    const clickSpy = jest.spyOn(controller, 'handleNavigationItemClick').mockResolvedValue();

    controller.createNavigationUI(container);

    expect(view.navigationOverlay).toBeDefined();
    expect(view.navigationPanel).toBeDefined();
    expect(view.navigationContent).toBeDefined();
    const navItems = container.querySelectorAll('.navigation-nav-item');
    expect(navItems).toHaveLength(5);
    expect(registerManagedDomEvent).toHaveBeenCalledTimes(5);

    navItems[0].dispatchEvent(new Event('click'));
    await Promise.resolve();
    expect(clickSpy).toHaveBeenCalledWith('routine');
  });

  test('initializeNavigationEventListeners connects overlay handler', () => {
    const { controller, view, registerManagedDomEvent } = createController();
    const overlay = document.createElement('div');
    attachCreateEl(overlay);
    view.navigationOverlay = overlay;

    const closeSpy = jest.spyOn(controller, 'closeNavigation');

    controller.initializeNavigationEventListeners();

    expect(registerManagedDomEvent).toHaveBeenCalledWith(overlay, 'click', expect.any(Function));

    overlay.click();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test('toggleNavigation switches open state and classes', () => {
    const { controller, view } = createController();
    const container = document.createElement('div');
    attachCreateEl(container);
    controller.createNavigationUI(container);

    expect(view.navigationState.isOpen).toBe(false);
    controller.toggleNavigation();
    expect(view.navigationState.isOpen).toBe(true);
    expect(view.navigationPanel?.classList.contains('navigation-panel-hidden')).toBe(false);
    expect(view.navigationOverlay?.classList.contains('navigation-overlay-hidden')).toBe(false);

    controller.toggleNavigation();
    expect(view.navigationState.isOpen).toBe(false);
    expect(view.navigationPanel?.classList.contains('navigation-panel-hidden')).toBe(true);
    expect(view.navigationOverlay?.classList.contains('navigation-overlay-hidden')).toBe(true);
  });
});
