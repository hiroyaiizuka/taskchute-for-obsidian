import { getScheduledTime } from '../utils/fieldMigration';

export interface ValidationWarning {
  code: string;
  message: string;
  suggestion?: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ValidationResult {
  warnings: ValidationWarning[];
  errors: ValidationWarning[];
}

export class TaskValidator {
  static validate(metadata: Record<string, unknown>): ValidationResult {
    const warnings: ValidationWarning[] = [];
    const errors: ValidationWarning[] = [];

    // null/undefined チェック
    if (!metadata) {
      return { warnings, errors };
    }

    // Phase 3: 新しいフィールドも検証
    const targetDate = metadata.target_date || metadata.temporary_move_date;

    // ルーチンタスクのtarget_date/temporary_move_date検証
    if (metadata.isRoutine && targetDate && metadata.routine_enabled !== false) {
      const routineStart = metadata.routine_start;

      // 日付の妥当性チェック
      if (this.isValidDate(targetDate) && this.isValidDate(routineStart)) {
        if (targetDate !== routineStart) {
          // target_dateがroutine_startより前
          if (targetDate < routineStart) {
            warnings.push({
              code: 'ROUTINE_STALE_TARGET_DATE',
              message: `target_date(${targetDate})がroutine_start(${routineStart})より前です。タスクが表示されません。`,
              suggestion: 'target_dateを削除してください',
              severity: 'high'
            });
          }
          // target_dateが過去
          else if (this.isPastDate(targetDate)) {
            warnings.push({
              code: 'ROUTINE_PAST_TARGET_DATE',
              message: `target_date(${targetDate})が過去の日付です。今日は表示されません。`,
              suggestion: '日跨ぎ移動でない場合はtarget_dateを削除してください',
              severity: 'medium'
            });
          }
          // target_dateが未来
          else if (this.isFutureDate(targetDate)) {
            warnings.push({
              code: 'ROUTINE_FUTURE_TARGET_DATE',
              message: `target_date(${targetDate})が未来の日付です。その日まで表示されません。`,
              suggestion: '今日表示したい場合はtarget_dateを削除してください',
              severity: 'medium'
            });
          }
        }
      }
    }

    // 非ルーチンタスクの古いtarget_date検証
    if (!metadata.isRoutine && metadata.target_date && this.isValidDate(metadata.target_date)) {
      const daysSinceTarget = this.daysSince(metadata.target_date);
      if (daysSinceTarget > 7) {
        warnings.push({
          code: 'OLD_TARGET_DATE',
          message: `タスクが${daysSinceTarget}日前から未実行です`,
          suggestion: '実行するか、削除を検討してください',
          severity: 'low'
        });
      }
    }

    // ルーチンタスクの異常な間隔設定を検証
    if (metadata.isRoutine && metadata.routine_interval) {
      if (metadata.routine_interval > 365) {
        warnings.push({
          code: 'EXCESSIVE_ROUTINE_INTERVAL',
          message: `ルーチン間隔が${metadata.routine_interval}日と長すぎます`,
          suggestion: '間隔を見直してください',
          severity: 'low'
        });
      }
    }

    return { warnings, errors };
  }

  static cleanupOnRoutineChange(
    metadata: Record<string, unknown>,
    changes: Record<string, unknown>
  ): Record<string, unknown> {
    // 入力をコピー
    const cleaned = { ...metadata, ...changes };

    // ルーチンタスクの場合のみクリーンアップ
    if (metadata.isRoutine) {
      // ルーチン設定が変更されたらtarget_dateを削除
      const hasTimeChange = getScheduledTime(changes) !== undefined ||
                           changes.開始時刻 !== undefined ||
                           changes.scheduled_time !== undefined;

      if (changes.routine_start !== undefined ||
          hasTimeChange ||
          changes.routine_type !== undefined ||
          changes.routine_interval !== undefined) {
        delete cleaned.target_date;
      }
    }

    return cleaned;
  }

  private static isValidDate(dateStr: string | null | undefined): boolean {
    if (!dateStr) return false;

    // YYYY-MM-DD形式をチェック
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr)) return false;

    // 実際に有効な日付かチェック
    const date = new Date(dateStr + 'T00:00:00');
    return !isNaN(date.getTime());
  }

  private static isPastDate(dateStr: string): boolean {
    if (!this.isValidDate(dateStr)) return false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    return dateStr < todayStr;
  }

  private static isFutureDate(dateStr: string): boolean {
    if (!this.isValidDate(dateStr)) return false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    return dateStr > todayStr;
  }

  private static daysSince(dateStr: string): number {
    if (!this.isValidDate(dateStr)) return 0;

    const target = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffTime = Math.abs(today.getTime() - target.getTime());
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }
}