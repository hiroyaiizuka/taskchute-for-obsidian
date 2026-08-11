import {
  getScheduledTime,
  setScheduledTime,
} from '../src/utils/fieldMigration';

describe('Field Migration Utilities', () => {
  describe('getScheduledTime', () => {
    test('新フィールド(scheduled_time)を優先して取得', () => {
      const fm = {
        scheduled_time: '09:00',
        '開始時刻': '10:00',
      };
      expect(getScheduledTime(fm)).toBe('09:00');
    });

    test('旧フィールド(開始時刻)のみの場合も取得', () => {
      const fm = { '開始時刻': '10:00' };
      expect(getScheduledTime(fm)).toBe('10:00');
    });

    test('新フィールド(scheduled_time)のみの場合も取得', () => {
      const fm = { scheduled_time: '11:00' };
      expect(getScheduledTime(fm)).toBe('11:00');
    });

    test('どちらもない場合はundefined', () => {
      const fm = { other_field: 'value' };
      expect(getScheduledTime(fm)).toBeUndefined();
    });

    test('nullの場合はundefined', () => {
      expect(getScheduledTime(null)).toBeUndefined();
    });

    test('undefinedの場合はundefined', () => {
      expect(getScheduledTime(undefined)).toBeUndefined();
    });

    test('空オブジェクトの場合はundefined', () => {
      expect(getScheduledTime({})).toBeUndefined();
    });
  });

  describe('setScheduledTime', () => {
    test('デフォルトでは旧フィールドを使用（後方互換性）', () => {
      const fm: Record<string, unknown> = {};
      setScheduledTime(fm, '09:00');
      expect(fm['開始時刻']).toBe('09:00');
      expect(fm.scheduled_time).toBeUndefined();
    });

    test('preferNew=trueで新フィールドを使用', () => {
      const fm: Record<string, unknown> = {};
      setScheduledTime(fm, '09:00', { preferNew: true });
      expect(fm.scheduled_time).toBe('09:00');
      expect(fm['開始時刻']).toBeUndefined();
    });

    test('値をクリアすると両フィールドを削除', () => {
      const fm: Record<string, unknown> = {
        scheduled_time: '09:00',
        '開始時刻': '10:00',
      };
      setScheduledTime(fm, undefined);
      expect(fm.scheduled_time).toBeUndefined();
      expect(fm['開始時刻']).toBeUndefined();
    });

    test('preferNew=trueで旧フィールドを新フィールドに移行', () => {
      const fm: Record<string, unknown> = {
        '開始時刻': '10:00',
      };
      setScheduledTime(fm, '11:00', { preferNew: true });
      expect(fm.scheduled_time).toBe('11:00');
      expect(fm['開始時刻']).toBeUndefined();
    });

    test('nullのfrontmatterには何もしない', () => {
      setScheduledTime(null, '09:00');
      // No error thrown
    });

    test('undefinedのfrontmatterには何もしない', () => {
      setScheduledTime(undefined, '09:00');
      // No error thrown
    });

    test('空文字列も削除として扱う', () => {
      const fm: Record<string, unknown> = {
        scheduled_time: '09:00',
        '開始時刻': '10:00',
      };
      setScheduledTime(fm, '');
      expect(fm.scheduled_time).toBeUndefined();
      expect(fm['開始時刻']).toBeUndefined();
    });
  });
});