import { t } from '../i18n';
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
  private static readonly NON_ROUTINE_STALE_THRESHOLD_DAYS = 7;

  private static getStringField(
    metadata: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = metadata[key]
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  }

  private static getNumberField(
    metadata: Record<string, unknown>,
    key: string,
  ): number | undefined {
    const value = metadata[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }

  static validate(metadata: Record<string, unknown>): ValidationResult {
    const warnings: ValidationWarning[] = [];
    const errors: ValidationWarning[] = [];

    // null/undefined チェック
    if (!metadata) {
      return { warnings, errors };
    }

    // Phase 3: 新しいフィールドも検証
    const targetDate =
      this.getStringField(metadata, 'target_date') ??
      this.getStringField(metadata, 'temporary_move_date')

    // ルーチンタスクのtarget_date/temporary_move_date検証
    const isRoutine = metadata.isRoutine === true
    const routineEnabled = metadata.routine_enabled !== false

    if (isRoutine && targetDate && routineEnabled) {
      const routineStart = this.getStringField(metadata, 'routine_start')

      // 日付の妥当性チェック
      if (this.isValidDate(targetDate) && routineStart && this.isValidDate(routineStart)) {
        if (targetDate !== routineStart) {
          // target_dateがroutine_startより前
          if (targetDate < routineStart) {
            warnings.push({
              code: 'ROUTINE_STALE_TARGET_DATE',
              message: t(
                'taskChuteView.validator.routineTargetBeforeStart',
                'target_date({targetDate}) is before routine_start({routineStart}). The task will not appear.',
                { targetDate, routineStart }
              ),
              suggestion: t(
                'taskChuteView.validator.suggestionRemoveTargetDate',
                'Remove target_date.',
              ),
              severity: 'high'
            });
          }
          // target_dateが過去
          else if (this.isPastDate(targetDate)) {
            warnings.push({
              code: 'ROUTINE_PAST_TARGET_DATE',
              message: t(
                'taskChuteView.validator.routineTargetPast',
                'target_date({targetDate}) is in the past. It will not appear today.',
                { targetDate }
              ),
              suggestion: t(
                'taskChuteView.validator.suggestionRemoveTargetDateNonCross',
                'Remove target_date unless this is a cross-day move.',
              ),
              severity: 'medium'
            });
          }
          // target_dateが未来
          else if (this.isFutureDate(targetDate)) {
            warnings.push({
              code: 'ROUTINE_FUTURE_TARGET_DATE',
              message: t(
                'taskChuteView.validator.routineTargetFuture',
                'target_date({targetDate}) is in the future. It will not appear until that date.',
                { targetDate }
              ),
              suggestion: t(
                'taskChuteView.validator.suggestionRemoveTargetDateToday',
                'Remove target_date if you want it to appear today.',
              ),
              severity: 'medium'
            });
          }
        }
      }
    }

    // 非ルーチンタスクの古いtarget_date検証
    const targetDateValue = this.getStringField(metadata, 'target_date')
    if (
      !isRoutine &&
      targetDateValue &&
      this.isValidDate(targetDateValue) &&
      this.isPastDate(targetDateValue)
    ) {
      const daysSinceTarget = this.daysSince(targetDateValue)
      if (daysSinceTarget > this.NON_ROUTINE_STALE_THRESHOLD_DAYS) {
        warnings.push({
          code: 'OLD_TARGET_DATE',
          message: t(
            'taskChuteView.validator.nonRoutineStale',
            'This task has been idle for {days} days.',
            { days: daysSinceTarget },
          ),
          suggestion: t(
            'taskChuteView.validator.suggestionReviewOrDelete',
            'Run the task or consider deleting it.',
          ),
          severity: 'low'
        });
      }
    }

    // ルーチンタスクの異常な間隔設定を検証
    const routineInterval = this.getNumberField(metadata, 'routine_interval')
    if (isRoutine && routineInterval) {
      if (routineInterval > 365) {
        warnings.push({
          code: 'EXCESSIVE_ROUTINE_INTERVAL',
          message: t(
            'taskChuteView.validator.routineIntervalTooLong',
            'Routine interval of {days} days is unusually long.',
            { days: routineInterval },
          ),
          suggestion: t(
            'taskChuteView.validator.suggestionReviewInterval',
            'Review the interval setting.',
          ),
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
      const hasTimeChange =
        getScheduledTime(changes) !== undefined ||
        Object.prototype.hasOwnProperty.call(changes, '開始時刻') ||
        Object.prototype.hasOwnProperty.call(changes, 'scheduled_time')

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
