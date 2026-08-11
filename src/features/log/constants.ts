export const LOG_INBOX_FOLDER = 'inbox'
export const LOG_INBOX_LEGACY_FOLDER = '.inbox'

export const LOG_HEATMAP_FOLDER = 'heatmap'
export const LOG_HEATMAP_LEGACY_FOLDER = '.heatmap'

export const LOG_BACKUP_FOLDER = 'backups'
export const LOG_BACKUP_LEGACY_FOLDER = '.backups'

/**
 * センチネル値: 旧スナップショット（meta未設定）を示すrevision
 * このrevisionを持つスナップショットは必ず競合検出を発動させ、マイグレーションを強制する
 */
export const LEGACY_REVISION = -1
