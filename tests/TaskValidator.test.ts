import { TaskValidator } from '../src/features/core/services/TaskValidator';

describe('TaskValidator', () => {
  describe('validateRoutineTask', () => {
    test('過去のtarget_dateが残っているルーチンタスクに警告を出す', () => {
      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-24',
        target_date: '2025-09-19',
        routine_enabled: true
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings).toContainEqual({
        code: 'ROUTINE_STALE_TARGET_DATE',
        message: 'target_date(2025-09-19) is before routine_start(2025-09-24). The task will not appear.',
        suggestion: 'Remove target_date.',
        severity: 'high'
      });
    });

    test('target_dateとroutine_startが同じ場合は警告なし', () => {
      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-24',
        target_date: '2025-09-24',
        routine_enabled: true
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings).toHaveLength(0);
    });

    test('非ルーチンタスクのtarget_dateは警告なし', () => {
      const today = new Date().toISOString().split('T')[0];
      const metadata = {
        isRoutine: false,
        target_date: today
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings).toHaveLength(0);
    });

    test('将来のtarget_dateを持つルーチンタスクに警告を出す', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-24',
        target_date: tomorrowStr,
        routine_enabled: true
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings).toContainEqual({
        code: 'ROUTINE_FUTURE_TARGET_DATE',
        message: `target_date(${tomorrowStr}) is in the future. It will not appear until that date.`,
        suggestion: 'Remove target_date if you want it to appear today.',
        severity: 'medium'
      });
    });

    test('無効化されたルーチンタスクは警告なし', () => {
      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-24',
        target_date: '2025-09-19',
        routine_enabled: false
      };

      const result = TaskValidator.validate(metadata);

      // 無効化されている場合はtarget_dateの警告を出さない
      const targetDateWarnings = result.warnings.filter(
        w => w.code.includes('TARGET_DATE')
      );
      expect(targetDateWarnings).toHaveLength(0);
    });
  });

  describe('autoCleanup', () => {
    test('ルーチン設定変更時にtarget_dateをクリーンアップ', () => {
      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-20',
        target_date: '2025-09-19',
        開始時刻: '10:00'
      };

      const cleaned = TaskValidator.cleanupOnRoutineChange(metadata, {
        routine_start: '2025-09-24'
      });

      expect(cleaned.target_date).toBeUndefined();
      expect(cleaned.routine_start).toBe('2025-09-24');
    });

    test('開始時刻変更時にもtarget_dateをクリーンアップ', () => {
      const metadata = {
        isRoutine: true,
        開始時刻: '10:00',
        target_date: '2025-09-19'
      };

      const cleaned = TaskValidator.cleanupOnRoutineChange(metadata, {
        開始時刻: '22:00'
      });

      expect(cleaned.target_date).toBeUndefined();
      expect(cleaned.開始時刻).toBe('22:00');
    });

    test('routine_type変更時にtarget_dateをクリーンアップ', () => {
      const metadata = {
        isRoutine: true,
        routine_type: 'daily',
        target_date: '2025-09-19'
      };

      const cleaned = TaskValidator.cleanupOnRoutineChange(metadata, {
        routine_type: 'weekly'
      });

      expect(cleaned.target_date).toBeUndefined();
      expect(cleaned.routine_type).toBe('weekly');
    });

    test('routine_interval変更時にtarget_dateをクリーンアップ', () => {
      const metadata = {
        isRoutine: true,
        routine_interval: 1,
        target_date: '2025-09-19'
      };

      const cleaned = TaskValidator.cleanupOnRoutineChange(metadata, {
        routine_interval: 2
      });

      expect(cleaned.target_date).toBeUndefined();
      expect(cleaned.routine_interval).toBe(2);
    });

    test('非ルーチンタスクはtarget_dateを保持', () => {
      const metadata = {
        isRoutine: false,
        target_date: '2025-09-19'
      };

      const cleaned = TaskValidator.cleanupOnRoutineChange(metadata, {
        開始時刻: '22:00'
      });

      expect(cleaned.target_date).toBe('2025-09-19');
    });

    test('関係ない変更ではtarget_dateを保持', () => {
      const metadata = {
        isRoutine: true,
        target_date: '2025-09-19',
        project: 'プロジェクトA'
      };

      const cleaned = TaskValidator.cleanupOnRoutineChange(metadata, {
        project: 'プロジェクトB'
      });

      expect(cleaned.target_date).toBe('2025-09-19');
    });
  });

  describe('非ルーチンタスクのバリデーション', () => {
    test('7日以上前のtarget_dateに警告', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 8);
      const oldDateStr = oldDate.toISOString().split('T')[0];

      const metadata = {
        isRoutine: false,
        target_date: oldDateStr
      };

      const result = TaskValidator.validate(metadata);

      const warning = result.warnings.find(w => w.code === 'OLD_TARGET_DATE');
      expect(warning).toBeDefined();
      expect(warning?.severity).toBe('low');
    });

    test('今日のtarget_dateは警告なし', () => {
      const today = new Date().toISOString().split('T')[0];

      const metadata = {
        isRoutine: false,
        target_date: today
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings).toHaveLength(0);
    });

    test('未来のtarget_dateは警告なし', () => {
      const future = new Date();
      future.setDate(future.getDate() + 7);
      const futureStr = future.toISOString().split('T')[0];

      const metadata = {
        isRoutine: false,
        target_date: futureStr
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('診断機能', () => {
    test('複数の警告を検出できる', () => {
      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-24',
        target_date: '2025-09-19',
        routine_enabled: true,
        routine_interval: 999 // 異常に大きい間隔
      };

      const result = TaskValidator.validate(metadata);

      expect(result.warnings.length).toBeGreaterThan(1);
      expect(result.warnings.some(w => w.code === 'ROUTINE_STALE_TARGET_DATE')).toBe(true);
    });

    test('severity レベルが正しく設定される', () => {
      const metadata = {
        isRoutine: true,
        routine_start: '2025-09-24',
        target_date: '2025-09-19',
        routine_enabled: true
      };

      const result = TaskValidator.validate(metadata);

      const warning = result.warnings.find(w => w.code === 'ROUTINE_STALE_TARGET_DATE');
      expect(warning?.severity).toBe('high');
    });
  });

  describe('エッジケース', () => {
    test('不正な日付フォーマットを処理できる', () => {
      const metadata = {
        isRoutine: true,
        routine_start: 'invalid-date',
        target_date: '2025-09-19'
      };

      expect(() => TaskValidator.validate(metadata)).not.toThrow();
    });

    test('null値を処理できる', () => {
      const metadata = {
        isRoutine: true,
        routine_start: null,
        target_date: null
      };

      expect(() => TaskValidator.validate(metadata)).not.toThrow();
    });

    test('undefined値を処理できる', () => {
      const metadata = {
        isRoutine: true
      };

      expect(() => TaskValidator.validate(metadata)).not.toThrow();
    });
  });
});
