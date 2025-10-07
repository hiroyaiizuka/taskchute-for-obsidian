import { TaskChutePluginLike, DayState } from '../../src/types';
import { Notice, WorkspaceLeaf } from 'obsidian';
import { TaskChuteView } from '../../src/views/TaskChuteView';

// モック設定
jest.mock('obsidian');

interface MockTaskListElement extends HTMLDivElement {
  empty: jest.Mock;
  createEl: jest.Mock;
}

interface MockLeaf {
  containerEl: HTMLElement;
}

describe('Navigate to today (showTodayTasks)', () => {
  let view: TaskChuteView;
  let mockPlugin: TaskChutePluginLike;
  let mockLeaf: MockLeaf;

  beforeEach(() => {
    // プラグインのモック
    mockPlugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(),
          getMarkdownFiles: jest.fn(() => []),
          read: jest.fn(async () => ''),
          modify: jest.fn(),
          create: jest.fn(),
          adapter: {
            stat: jest.fn(async () => ({ ctime: Date.now(), mtime: Date.now() })),
            exists: jest.fn(async () => false),
            read: jest.fn(async () => '{}'),
            write: jest.fn(),
            mkdir: jest.fn(),
          },
        },
        metadataCache: {
          getFileCache: jest.fn(() => null),
        },
        workspace: {
          openLinkText: jest.fn(),
        },
      },
      settings: {
        slotKeys: {},
        useOrderBasedSort: true,
        taskFolderPath: 'TASKS',
        projectFolderPath: 'PROJECTS',
        logDataPath: 'LOGS',
        reviewDataPath: 'REVIEWS',
      },
      saveSettings: jest.fn(),
      pathManager: {
        getTaskFolderPath: () => 'TASKS',
        getProjectFolderPath: () => 'PROJECTS',
        getLogDataPath: () => 'LOGS',
        getReviewDataPath: () => 'REVIEWS',
        ensureFolderExists: jest.fn(),
      },
      dayStateService: {
        loadDay: jest.fn(async () => ({
          hiddenRoutines: [],
          deletedInstances: [],
          duplicatedInstances: [],
          slotOverrides: {},
          orders: {},
        } as DayState)),
        saveDay: jest.fn(),
      },
      routineAliasManager: {
        getRouteNameFromAlias: jest.fn((name: string) => name),
      },
      _notify: jest.fn(),
    } as unknown as TaskChutePluginLike;

    // WorkspaceLeafのモック
    mockLeaf = {
      containerEl: document.createElement('div'),
    };

    // TaskChuteViewのインスタンスを作成
    view = new TaskChuteView(mockLeaf as WorkspaceLeaf, mockPlugin);

    // 必要なプロパティを設定
    view.containerEl = document.createElement('div');

    // taskListにemptyメソッドを追加
    const taskListEl = document.createElement('div') as MockTaskListElement;
    taskListEl.empty = jest.fn(() => {
      taskListEl.innerHTML = '';
    });
    taskListEl.createEl = jest.fn((tag: string) => {
      const el = document.createElement(tag);
      taskListEl.appendChild(el);
      return el;
    });
    view.taskList = taskListEl;

    view.app = mockPlugin.app;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('DayState cache clearing', () => {
    test('should clear currentDayStateKey and currentDayState when navigating to today', async () => {
      // 3日後の日付を設定
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);
      view['currentDate'] = futureDate;

      // DayStateキャッシュを設定（3日後の日付でキャッシュされた状態をシミュレート）
      const futureDateStr = `${futureDate.getFullYear()}-${(futureDate.getMonth() + 1).toString().padStart(2, '0')}-${futureDate.getDate().toString().padStart(2, '0')}`;
      view['currentDayStateKey'] = futureDateStr;
      view['currentDayState'] = {
        hiddenRoutines: ['future-routine'],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: {},
        orders: {},
      } as DayState;

      // showTodayTasksを呼び出す前の状態を確認
      expect(view['currentDayStateKey']).toBe(futureDateStr);
      expect(view['currentDayState']).not.toBeNull();
      expect(view['currentDayState']?.hiddenRoutines).toContain('future-routine');

      // showTodayTasksを実行
      view.showTodayTasks();

      // DayStateキャッシュがクリアされていることを確認
      expect(view['currentDayStateKey']).toBeNull();
      expect(view['currentDayState']).toBeNull();

      // 今日の日付が設定されていることを確認
      const today = new Date();
      const currentDate = view['currentDate'];
      expect(currentDate.getFullYear()).toBe(today.getFullYear());
      expect(currentDate.getMonth()).toBe(today.getMonth());
      expect(currentDate.getDate()).toBe(today.getDate());
    });
  });

  describe('Date navigation after creating new task', () => {
    test('should navigate to today correctly after creating task on future date', async () => {
      // 3日後の日付を設定
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);
      view['currentDate'] = futureDate;

      // 3日後の日付でタスクを作成した状態をシミュレート
      const futureDateStr = `${futureDate.getFullYear()}-${(futureDate.getMonth() + 1).toString().padStart(2, '0')}-${futureDate.getDate().toString().padStart(2, '0')}`;
      view['currentDayStateKey'] = futureDateStr;

      // dayStateCache に3日後のデータを設定
      view['dayStateCache'].set(futureDateStr, {
        hiddenRoutines: [],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: { 'TASKS/future-task.md': '10:00' },
        orders: {},
      } as DayState);

      // ensureDayStateForCurrentDateをモック
      view['ensureDayStateForCurrentDate'] = jest.fn(async () => {
        const dateStr = view['getCurrentDateString']();
        const cached = view['dayStateCache'].get(dateStr);
        if (cached) {
          view['currentDayState'] = cached;
          view['currentDayStateKey'] = dateStr;
          return cached;
        }
        const newState: DayState = {
          hiddenRoutines: [],
          deletedInstances: [],
          duplicatedInstances: [],
          slotOverrides: {},
          orders: {},
        };
        view['dayStateCache'].set(dateStr, newState);
        view['currentDayState'] = newState;
        view['currentDayStateKey'] = dateStr;
        return newState;
      });

      // loadTasksをモック
      view['loadTasks'] = jest.fn(async () => {
        await view['ensureDayStateForCurrentDate']();
      });

      // restoreRunningTaskStateをモック
      view['restoreRunningTaskState'] = jest.fn();

      // renderTaskListをモック
      view['renderTaskList'] = jest.fn();

      // checkBoundaryTasksをモック
      view['checkBoundaryTasks'] = jest.fn();

      // scheduleBoundaryCheckをモック
      view['scheduleBoundaryCheck'] = jest.fn();

      // updateDateLabelをモック
      view['updateDateLabel'] = jest.fn();

      // showTodayTasksを実行
      view.showTodayTasks();

      // 非同期処理を待つ
      await new Promise(resolve => setTimeout(resolve, 100));

      // currentDateが今日に設定されていることを確認
      const today = new Date();
      const currentDate = view['currentDate'];
      expect(currentDate.getFullYear()).toBe(today.getFullYear());
      expect(currentDate.getMonth()).toBe(today.getMonth());
      expect(currentDate.getDate()).toBe(today.getDate());

      // DayStateキャッシュがクリアされていることを確認
      // showTodayTasksでnullに設定されるが、その後のreloadTasksAndRestoreでensureDayStateForCurrentDateが呼ばれて
      // 今日の日付で新しく設定される
      // const todayStr = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;

      // loadTasksが呼ばれたことを確認
      expect(view['loadTasks']).toHaveBeenCalled();

      // ensureDayStateForCurrentDateが呼ばれた時点で、今日の日付で新しいDayStateが設定される
      expect(view['ensureDayStateForCurrentDate']).toHaveBeenCalled();
    });

    test('should not carry over future date cache when returning to today', async () => {
      // 3日後の日付を設定
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);
      const futureDateStr = `${futureDate.getFullYear()}-${(futureDate.getMonth() + 1).toString().padStart(2, '0')}-${futureDate.getDate().toString().padStart(2, '0')}`;

      // 3日後のキャッシュを設定
      view['currentDate'] = futureDate;
      view['currentDayStateKey'] = futureDateStr;
      view['currentDayState'] = {
        hiddenRoutines: ['future-routine'],
        deletedInstances: [{ path: 'TASKS/future-deleted.md', deletionType: 'permanent', timestamp: Date.now() }],
        duplicatedInstances: [],
        slotOverrides: { 'TASKS/future-task.md': '15:00' },
        orders: { 'TASKS/future-task.md': 5 },
      } as DayState;

      // showTodayTasksを実行
      view.showTodayTasks();

      // キャッシュがクリアされることを確認
      expect(view['currentDayStateKey']).toBeNull();
      expect(view['currentDayState']).toBeNull();

      // キャッシュがクリアされているので、currentDayStateはnullであることを確認
      // （reloadTasksAndRestoreが呼ばれる前の段階では）
      // 将来の日付のデータが持ち越されていないことを確認
      if (view['currentDayState']) {
        expect(view['currentDayState'].hiddenRoutines).not.toContain('future-routine');
        expect(view['currentDayState'].slotOverrides).not.toHaveProperty('TASKS/future-task.md');
        expect(view['currentDayState'].orders).not.toHaveProperty('TASKS/future-task.md');
      }
    });
  });

  describe('Notice display', () => {
    test('should display notice message after navigation', async () => {
      // モック関数を設定
      view['reloadTasksAndRestore'] = jest.fn(async () => {});
      view['updateDateLabel'] = jest.fn();

      // showTodayTasksを実行
      view.showTodayTasks();

      // 非同期処理を待つ
      await new Promise(resolve => setTimeout(resolve, 100));

      // Noticeが表示されることを確認
      expect(Notice).toHaveBeenCalledWith('今日のタスクを表示しました');
    });
  });
});
