// Complete CSS styles from original implementation
export const TASKCHUTE_FULL_CSS = `
.taskchute-container {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

/* Log Modal Styles */
.taskchute-log-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.taskchute-log-modal-content {
    background: var(--background-primary);
    border-radius: 8px;
    width: 90%;
    max-width: 1200px;
    height: 80%;
    max-height: 800px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
}

.log-modal-close {
    position: absolute;
    top: 10px;
    right: 10px;
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    color: var(--text-muted);
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
}

.log-modal-close:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
}

.taskchute-log-header {
    padding: 20px;
    border-bottom: 1px solid var(--background-modifier-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.log-title {
    margin: 0;
    font-size: 24px;
}

.log-controls {
    display: flex;
    gap: 10px;
    align-items: center;
}

.year-selector {
    padding: 5px 10px;
    border-radius: 4px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
    color: var(--text-normal);
    font-size: 14px;
}

.refresh-button {
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
    color: var(--text-normal);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s ease;
}

.refresh-button:hover {
    background: var(--background-modifier-hover);
    border-color: var(--text-accent);
}

.heatmap-container {
    flex: 1;
    padding: 20px;
    overflow: auto;
}

.heatmap-grid {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
}

.heatmap-placeholder {
    color: var(--text-muted);
    font-size: 16px;
}

/* Heatmap Grid Styles */
.heatmap-grid-container {
    padding: 20px;
}

.heatmap-months {
    position: relative;
    height: 20px;
    margin-bottom: 8px;
    margin-left: 43px;
}

.month-label {
    font-size: 10px;
    color: var(--text-muted);
    position: absolute;
    top: 0;
    text-align: left;
}

.heatmap-weekdays-container {
    display: flex;
    gap: 10px;
}

.heatmap-weekdays {
    display: grid;
    grid-template-rows: repeat(7, 1fr);
    gap: 2px;
    width: 20px;
}

.weekday-label {
    font-size: 10px;
    color: var(--text-muted);
    height: 11px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 4px;
}

.heatmap-grid {
    display: grid;
    grid-template-rows: repeat(7, 11px);
    gap: 2px;
    grid-auto-flow: column;
    width: fit-content;
}

.heatmap-cell {
    width: 11px;
    height: 11px;
    background: var(--background-modifier-border);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
}

.heatmap-cell.empty {
    background: transparent;
    cursor: default;
}

.heatmap-cell[data-level="0"] {
    background: #ebedf0;
}

.heatmap-cell[data-level="1"] {
    background: #DEF95D;
}

.heatmap-cell[data-level="2"] {
    background: #B5EE4F;
}

.heatmap-cell[data-level="3"] {
    background: #82D523;
}

.heatmap-cell[data-level="4"] {
    background: #54A923;
}

@keyframes pulse {
    0% {
        box-shadow: 0 0 0 0 rgba(118, 75, 162, 0.7);
    }
    70% {
        box-shadow: 0 0 0 10px rgba(118, 75, 162, 0);
    }
    100% {
        box-shadow: 0 0 0 0 rgba(118, 75, 162, 0);
    }
}

.heatmap-cell:hover {
    outline: 1px solid var(--text-normal);
    outline-offset: -1px;
}

.heatmap-cell.month-start {
    margin-left: 4px;
}

.heatmap-legend {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 10px;
    margin-left: 30px;
    font-size: 12px;
    color: var(--text-muted);
}

.legend-scale {
    display: flex;
    gap: 2px;
}

.legend-cell {
    width: 11px;
    height: 11px;
    border-radius: 2px;
}

/* Loading styles */
.heatmap-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    color: var(--text-muted);
    font-size: 14px;
}

/* Error styles */
.heatmap-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    color: var(--text-error);
    font-size: 14px;
    background: var(--background-modifier-error);
    border-radius: 4px;
    margin-bottom: 20px;
}

.legend-cell[data-level="0"] {
    background: #ebedf0;
}

.legend-cell[data-level="1"] {
    background: #DEF95D;
}

.legend-cell[data-level="2"] {
    background: #B5EE4F;
}

.legend-cell[data-level="3"] {
    background: #82D523;
}

.legend-cell[data-level="4"] {
    background: #54A923;
}

/* Heatmap Tooltip */
.heatmap-tooltip {
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 8px;
    font-size: 12px;
    white-space: pre-line;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    pointer-events: none;
}

/* TASK-012: タスク名自動補完のスタイル */
.task-name-suggestions {
    position: absolute;
    z-index: 1000;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    margin-top: 2px;
}

.suggestion-item {
    padding: 8px 12px;
    cursor: pointer;
    transition: background-color 0.1s;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.suggestion-item:hover,
.suggestion-item-selected {
    background-color: var(--background-modifier-hover);
}

.suggestion-item-selected {
    background-color: var(--background-modifier-hover);
    font-weight: 500;
}

/* Main Container Layout */
.main-container {
    display: flex;
    position: relative;
    flex: 1;
    min-height: 0;
}

/* Top Bar Container */
.top-bar-container {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    height: 30px; /* Fixed height matching date navigation */
}

/* Header Divider */
.header-divider {
    width: 1px;
    height: 20px;
    background-color: var(--background-modifier-border);
    margin: 5px 0;
}

/* Header Action Section */
.header-action-section {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* Drawer Toggle Button */
.drawer-toggle {
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 0 10px;
    cursor: pointer;
    font-size: 16px;
    transition: background-color 0.2s ease;
    height: 100%;
    display: flex;
    align-items: center;
}

.drawer-toggle:hover {
    background: var(--background-modifier-hover);
}

/* Navigation Overlay */
.navigation-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.3);
    z-index: 999;
    transition: opacity 0.3s ease;
}

.navigation-overlay-hidden {
    opacity: 0;
    pointer-events: none;
}

.navigation-overlay-visible {
    opacity: 1;
    pointer-events: auto;
}

/* Navigation Panel */
.navigation-panel {
    position: fixed;
    left: 0;
    top: 0;
    height: 100%;
    width: 250px;
    background: var(--background-primary);
    border-right: 1px solid var(--background-modifier-border);
    box-shadow: 2px 0 10px rgba(0, 0, 0, 0.1);
    z-index: 1000;
    transition: transform 0.3s ease;
    overflow-y: auto;
}

.navigation-panel-hidden {
    transform: translateX(-100%);
}

.navigation-panel-visible {
    transform: translateX(0);
}

/* Navigation Header - removed close button */
.navigation-header {
    display: none;
}

/* Navigation Items */
.navigation-nav {
    padding: 20px 0;
}

.navigation-nav-item {
    display: flex;
    align-items: center;
    padding: 10px 15px;
    cursor: pointer;
    transition: background-color 0.2s ease;
}

.navigation-nav-item:hover {
    background: var(--background-modifier-hover);
}

.navigation-nav-item.active {
    background: var(--background-modifier-active);
    font-weight: 500;
}

.navigation-nav-icon {
    margin-right: 10px;
    font-size: 16px;
}

.navigation-nav-label {
    font-size: 13px;
}
.task-list-container {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
}

.button-container {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin: 15px 0;
}

.task-button {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 70px;
}

.task-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.task-button.start {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
}

.task-button.start:hover:not(:disabled) {
    background: var(--interactive-accent-hover);
}

.task-button.stop {
    background: #e74c3c;
    color: white;
}

.task-button.stop:hover {
    background: #c0392b;
}

.task-button.reset {
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

.task-button.reset:hover {
    background: var(--background-modifier-border-hover);
}

.future-task-button {
    background-color: var(--background-modifier-border) !important;
    color: var(--text-muted) !important;
    cursor: not-allowed !important;
}


.task-list-container {
    margin-top: 10px;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.task-list-container h5 {
    margin: 0 0 10px 0;
    color: var(--text-muted);
}

.task-list {
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    padding-bottom: 50px;
    display: flex;
    flex-direction: column;
    overflow: auto;
}

.task-item {
    padding: 8px 12px;
    cursor: default;
    border-bottom: 1px solid var(--background-modifier-border);
    transition: background-color 0.2s ease;
}

.task-item:last-child {
    border-bottom: none;
}

.task-item:hover {
    background: var(--background-secondary);
}

.task-item.selected {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
}

.task-item.keyboard-selected {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    box-shadow: 0 0 0 2px var(--interactive-accent-hover);
}

.task-item.completed {
    cursor: default;
}

/* 完了済みタスクのドラッグハンドルは表示するが無効化 */
.drag-handle.disabled {
    cursor: default;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
}

.task-item:hover .drag-handle.disabled {
    opacity: 0.3;
}

.task-item {
    display: grid;
    grid-template-columns: 20px 40px 1fr 220px 110px 50px 30px 30px 30px;
    gap: 8px;
    align-items: center;
    padding: 2px 10px 2px 15px;
    margin: 2px 0;
}

/* ドラッグハンドルのスタイル */
.drag-handle {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.2s ease, background-color 0.2s ease;
    border-radius: 4px;
}

.task-item:hover .drag-handle {
    opacity: 0.6;
}

.drag-handle:hover {
    opacity: 1 !important;
    color: var(--text-normal);
    background-color: var(--background-modifier-hover);
}

.drag-handle:active {
    cursor: grabbing;
}

.drag-handle svg {
    width: 10px;
    height: 16px;
}

.task-item.dragging {
    opacity: 0.5;
    background: var(--background-modifier-hover);
    transform: scale(0.98);
    transition: all 0.2s ease;
}

.task-item.dragover {
    border-top: 2px solid var(--interactive-accent);
    margin-top: -2px;
}

.task-item.dragover-invalid {
    border-top: 2px solid var(--text-error);
    margin-top: -2px;
    opacity: 0.7;
    cursor: not-allowed;
    background-color: rgba(255, 0, 0, 0.05);
    position: relative;
}

.task-item.dragover-invalid::after {
    content: "❌ ここには配置できません";
    position: absolute;
    top: -25px;
    left: 50%;
    transform: translateX(-50%);
    background-color: var(--text-error);
    color: white;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    z-index: 1000;
    pointer-events: none;
}

.task-name {
    cursor: pointer;
    font-weight: 500;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: -4px; /* プロジェクトとの間隔を狭める */
}

.task-time-range {
    font-size: 12px;
    color: var(--text-muted);
    font-family: monospace;
    white-space: nowrap;
    text-align: center;
    display: flex;
    justify-content: center;
    align-items: center;
}
.task-time-range.editable {
    cursor: pointer;
    text-decoration: none;
}
.task-duration,
.task-timer-display {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    font-family: monospace;
}

.task-timer-display {
    color: var(--interactive-accent);
    font-weight: bold;
}

.time-slot-header {
    background: var(--background-secondary);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    margin: 8px 0 4px 0;
    border-radius: 4px;
    border-left: 3px solid var(--interactive-accent);
}

.time-slot-header.other {
    border-left-color: var(--background-modifier-border);
}

.time-slot-header.dragover {
    background: var(--background-modifier-hover);
    border-left-width: 5px;
    transition: all 0.2s ease;
}

.routine-button {
    background: none;
    border: none;
    font-size: 14px;
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    transition: all 0.2s ease;
    opacity: 0.4;
    width: 100%;
    text-align: center;
}

.routine-button:hover {
    opacity: 1;
    background: var(--background-modifier-border);
}

.routine-button.active {
    opacity: 1;
    color: var(--interactive-accent);
}

/* コメントボタンスタイル */
.comment-button {
    font-size: 15px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 2px;
    border-radius: 4px;
    transition: all 0.2s ease;
    opacity: 0;
    width: 100%;
    text-align: center;
    visibility: visible; /* デフォルトは表示 */
}

.task-item:hover .comment-button:not(.disabled) {
    opacity: 0.6;
}

.comment-button:not(.disabled):hover {
    opacity: 1 !important;
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

/* コメントボタンの無効化スタイル - スペースは維持して非表示 */
.comment-button.disabled {
    visibility: hidden;
}

/* 既存コメントがある場合は表示するが、クリック不可 */
.comment-button.disabled.active {
    visibility: visible;
    opacity: 0.6;
    pointer-events: none;
    cursor: not-allowed;
}

.comment-button.active {
    opacity: 0.6;
    color: var(--interactive-accent);
}

.task-item:hover .comment-button.active {
    opacity: 1;
}

/* 完了済みでコメント未記入のタスク - 通常時非表示、ホバー時表示（空間は保持） */
.comment-button.no-comment {
    opacity: 0;
    visibility: hidden;
}

.task-item:hover .comment-button.no-comment {
    opacity: 0.6;
    visibility: visible;
}

/* プロジェクト表示コンポーネント全体 */
.taskchute-project-display {
    display: flex;
    align-items: center;
    gap: 4px;
    justify-content: flex-start;
    margin-right: 32px; /* 時間との間隔を広げる */
}

/* プロジェクトボタン（フォルダアイコン + プロジェクト名） */
.taskchute-project-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    color: var(--text-normal);
    font-size: 13px;
    max-width: 100%;
}

.taskchute-project-button:hover {
    background: var(--background-modifier-hover);
    border-color: var(--interactive-accent);
}

/* プロジェクト未設定の場合 */
.taskchute-project-button.empty {
    color: var(--text-muted);
    border-style: dashed;
}

/* フォルダアイコン */
.taskchute-project-icon {
    font-size: 14px;
    flex-shrink: 0;
}

/* プロジェクト名 */
.taskchute-project-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* External Linkアイコン */
.taskchute-external-link {
    font-size: 14px;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    transition: all 0.2s ease;
    color: var(--text-muted);
}

.taskchute-external-link:hover {
    background: var(--background-modifier-hover);
    color: var(--interactive-accent);
}

/* プロジェクト未設定時のプレースホルダー */
.taskchute-project-placeholder {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
    opacity: 0;
    border: 1px dashed var(--background-modifier-border);
    color: var(--text-muted);
    font-size: 13px;
    min-width: 100px;
}

.taskchute-project-placeholder::before {
    content: "📁 プロジェクトを設定";
    font-size: 13px;
}

.task-item:hover .taskchute-project-placeholder {
    opacity: 0.6;
}

/* ホバー時の明るくなる効果を削除 */
.taskchute-project-placeholder:hover {
    /* opacity: 1 !important; 削除 */
    /* background: var(--background-modifier-hover); 削除 */
    /* border-color: var(--interactive-accent); 削除 */
    /* color: var(--text-normal); 削除 */
}

/* プロジェクトボタンスタイル */
.project-button,
.project-placeholder {
    margin-left: 15px;
    margin-right: 4px;
    font-size: 14px;
    border: none;
    background: none;
    padding: 2px 6px;
    border-radius: 4px;
    transition: all 0.2s ease;
    min-width: 26px; /* 一定の幅を確保 */
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.project-button {
    cursor: pointer;
    color: var(--text-muted);
    opacity: 0.7;
}

.project-button:hover {
    opacity: 1;
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

.project-placeholder {
    /* 透明でスペースのみ確保 */
    opacity: 0;
    pointer-events: none;
}

.task-list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    gap: 8px;
}

.header-left-section {
    display: flex;
    align-items: center;
    gap: 8px;
}

.header-left-section h5 {
    margin: 0;
    color: var(--text-muted);
}

.header-right-section {
    display: flex;
    align-items: center;
}

/* Grayed out effect for task list */
.task-list-container.grayed-out {
    opacity: 0.6;
    pointer-events: none;
}

.add-task-button {
    margin-left: 0;
    margin-right: 15px;
}

.add-task-button.repositioned {
    margin-left: 0;
    margin-right: 0;
}

.robot-terminal-button {
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 16px;
    transition: background-color 0.2s ease;
    margin-right: 15px;
}

.robot-terminal-button:hover {
    background: var(--background-modifier-hover);
}

/* モーダルスタイル */
.task-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.task-modal-content {
    background: var(--background-primary);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    width: 90%;
    max-width: 500px;
    max-height: 80vh;
    overflow-y: auto;
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 20px 0 20px;
    border-bottom: 1px solid var(--background-modifier-border);
}

.modal-header h3 {
    margin: 0;
    color: var(--text-normal);
}

.modal-close-button {
    background: none;
    border: none;
    font-size: 24px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.2s ease;
}

.modal-close-button:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

.task-form {
    padding: 20px;
}

.form-group {
    margin-bottom: 15px;
}

.form-label {
    display: block;
    margin-bottom: 5px;
    font-weight: 500;
    color: var(--text-normal);
}

.form-input,
.form-textarea {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: inherit;
    font-size: 14px;
    box-sizing: border-box;
}

/* セレクトボックスの高さ調整 */
select.form-input {
    min-height: 36px;
    line-height: 1.5;
    padding: 8px 12px;
}

.form-input:focus,
.form-textarea:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
}

.form-textarea {
    min-height: 80px;
    resize: vertical;
}

.form-button-group {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 20px;
}

.form-button {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 80px;
}

.form-button.cancel {
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

.form-button.cancel:hover {
    background: var(--background-modifier-border-hover);
}

.form-button.create {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
}

.form-button.create:hover {
    background: var(--interactive-accent-hover);
}

.form-description {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.4;
}

.task-name.wikilink {
    color: var(--link-color);
    text-decoration: none;
    cursor: pointer;
    font-weight: 500;
    border-radius: 3px;
    padding: 2px 4px;
    transition: background 0.15s;
}
.task-name.wikilink:hover {
    background: var(--background-modifier-hover);
    color: var(--link-color-hover);
}
.play-stop-button {
    font-size: 18px;
    border: none;
    background: none;
    cursor: pointer;
    transition: color 0.2s;
    color: #3498db;
    padding: 2px;
    border-radius: 4px;
    width: 100%;
    text-align: center;
}
.play-stop-button.stop {
    color: #e74c3c;
    font-weight: bold;
    background: var(--background-modifier-border);
}
.task-item.selected {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    font-weight: bold;
}
.delete-task-button {
    margin-left: 8px;
    font-size: 15px;
    border: none;
    background: none;
    cursor: pointer;
    color: #e74c3c;
    padding: 2px 6px;
    border-radius: 4px;
    transition: background 0.2s;
}
.delete-task-button:hover {
    background: var(--background-modifier-border);
}

/* 設定ボタンスタイル */
.settings-task-button {
    font-size: 15px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 2px;
    margin-right: 10px;
    border-radius: 4px;
    transition: all 0.2s ease;
    opacity: 0.6;
    width: 100%;
    text-align: center;
}

.settings-task-button:hover {
    opacity: 1;
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

/* ツールチップスタイル */
.task-settings-tooltip {
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    padding: 4px 0;
    min-width: 140px;
    font-size: 13px;
    z-index: 1000;
}

.tooltip-header {
    display: flex;
    justify-content: flex-end;
    padding: 4px 8px 0 8px;
    margin-bottom: 4px;
}

.tooltip-close-button {
    background: none;
    border: none;
    font-size: 16px;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    transition: all 0.2s ease;
}

.tooltip-close-button:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

.tooltip-item {
    padding: 8px 12px;
    cursor: pointer;
    transition: background-color 0.2s ease;
    display: flex;
    align-items: center;
    gap: 8px;
}

.tooltip-item:hover {
    background: var(--background-secondary);
}

.tooltip-item.delete-item:hover {
    background: rgba(231, 76, 60, 0.1);
}

.tooltip-item.project-item {
    color: var(--text-normal);
}

.tooltip-item.project-item:hover {
    background: var(--background-secondary);
}

.tooltip-item.disabled {
    opacity: 0.5;
    color: var(--text-muted);
    cursor: not-allowed;
}

.tooltip-item.disabled:hover {
    background: none;
}

.date-nav-container {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 8px;
    gap: 2px;
    height: 36px;
}

.date-nav-container.compact {
    flex: 1; /* Take remaining space in top-bar-container */
    margin-bottom: 0; /* Remove bottom margin */
    gap: 1px;
    height: 100%; /* Match parent height */
    display: flex;
    align-items: center;
    justify-content: center;
}

.date-nav-arrow {
    background: none;
    border: none;
    font-size: 28px;
    color: #888;
    cursor: pointer;
    padding: 0 8px;
    transition: color 0.2s;
}

.date-nav-container.compact .date-nav-arrow {
    font-size: 20px;
    padding: 0 4px;
}

.date-nav-arrow:hover {
    color: #1976d2;
}

.date-nav-label {
    font-size: 15px;
    font-weight: bold;
    color: #1976d2;
    min-width: 90px;
    text-align: center;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    margin-right: 3px;
}

.date-nav-container.compact .date-nav-label {
    font-size: 15px;
    min-width: 90px;
    letter-spacing: 0.5px;
    height: 24px;
}
.calendar-btn {
    background: none;
    border: none;
    font-size: 16px;
    padding: 2px 2px;
    margin: 0 1px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    width: 24px;
    border-radius: 6px;
    transition: background 0.2s;
}
.calendar-btn:hover {
    background: var(--background-modifier-border);
}
.date-wikilink {
    color: #1976d2 !important;
    font-weight: bold;
    text-decoration: none;
    display: inline-block;
    text-align: center;
    min-width: 60px;
    padding: 0 1px;
}

/* 完了演出スタイル */


@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}



@keyframes bounceIn {
    0% {
        transform: scale(0.3);
        opacity: 0;
    }
    50% {
        transform: scale(1.05);
    }
    70% {
        transform: scale(0.9);
    }
    100% {
        transform: scale(1);
        opacity: 1;
    }
}



@keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
}



.fireworks-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
}

.firework {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    animation: fireworkExplosion 2s ease-out forwards;
}

@keyframes fireworkExplosion {
    0% {
        transform: scale(0);
        opacity: 1;
    }
    50% {
        transform: scale(1);
        opacity: 1;
    }
    100% {
        transform: scale(0);
        opacity: 0;
    }
}




/* 花火の追加エフェクト */
.firework::before,
.firework::after {
    content: '';
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: inherit;
    animation: fireworkSparkle 2s ease-out forwards;
}

.firework::before {
    animation-delay: 0.1s;
}

.firework::after {
    animation-delay: 0.2s;
}

@keyframes fireworkSparkle {
    0% {
        transform: scale(0) rotate(0deg);
        opacity: 1;
    }
    100% {
        transform: scale(2) rotate(360deg);
        opacity: 0;
    }
}

/* パーティクル効果 */
.particle {
    position: absolute;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    animation: particleExplosion 1.5s ease-out forwards;
}

@keyframes particleExplosion {
    0% {
        transform: scale(0) translateX(0);
        opacity: 1;
    }
    50% {
        transform: scale(1) translateX(50px);
        opacity: 1;
    }
    100% {
        transform: scale(0) translateX(100px);
        opacity: 0;
    }
}

/* 追加の演出効果 */


@keyframes glowPulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.8; }
}

/* 統計表示スタイル */


.stat-item {
    text-align: center;
    background: rgba(255, 255, 255, 0.1);
    padding: 15px;
    border-radius: 10px;
    backdrop-filter: blur(10px);
}

.stat-number {
    display: block;
    font-size: 24px;
    font-weight: bold;
    color: white;
    margin-bottom: 5px;
}

.stat-label {
    display: block;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.8);
}

/* 紙吹雪エフェクト */
.confetti-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: hidden;
}

.confetti {
    position: absolute;
    top: -10px;
    border-radius: 2px;
    animation: confettiFall 3s linear forwards;
}

@keyframes confettiFall {
    0% {
        transform: translateY(-10px) rotate(0deg);
        opacity: 1;
    }
    100% {
        transform: translateY(100vh) rotate(720deg);
        opacity: 0;
    }
}

/* 追加の演出効果 */


@keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
}

/* チェックボックススタイル */
.form-checkbox {
    margin-left: 10px;
    width: 16px;
    height: 16px;
    accent-color: var(--interactive-accent);
}

.form-checkbox:checked {
    background-color: var(--interactive-accent);
    border-color: var(--interactive-accent);
}

/* ラジオボタングループスタイル */
.radio-group {
    display: flex;
    gap: 20px;
    margin-top: 8px;
}

.radio-group input[type="radio"] {
    margin-right: 8px;
    accent-color: var(--interactive-accent);
}

.radio-group label {
    display: flex;
    align-items: center;
    cursor: pointer;
    font-size: 14px;
    color: var(--text-normal);
}

/* セレクトボックススタイル */
.form-input[type="time"],
.form-input[type="select"] {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: inherit;
    font-size: 14px;
    box-sizing: border-box;
}

.form-input[type="time"]:focus,
.form-input[type="select"]:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
}

/* タスク完了コメントモーダルのスタイル */
.completion-modal {
    max-width: 500px;
    max-height: 80vh;
    overflow-y: auto;
}

.completion-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.completion-time-info {
    background: var(--background-secondary);
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
}

.completion-time-info p {
    margin: 4px 0;
    font-size: 14px;
    color: var(--text-normal);
}

.completion-rating-section {
    background: var(--background-secondary);
    padding: 16px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
}

.completion-rating-section h4 {
    margin: 0 0 16px 0;
    font-size: 16px;
    color: var(--text-normal);
}

.rating-group {
    margin-bottom: 16px;
}

.rating-label {
    display: block;
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-normal);
}

.star-rating {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
}

.star-rating .star {
    font-size: 20px;
    cursor: pointer;
    transition: all 0.2s ease;
    user-select: none;
    opacity: 0.3;
}

.star-rating .star:hover {
    transform: scale(1.2);
}

.energy-select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: inherit;
    font-size: 14px;
    box-sizing: border-box;
}

.energy-select:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
}

.completion-comment {
    width: 100%;
    min-height: 100px;
    padding: 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: inherit;
    font-size: 14px;
    resize: vertical;
    box-sizing: border-box;
}

/* 入力時のテキスト色を明るくする */
.completion-comment:not(:placeholder-shown) {
    color: rgba(255, 255, 255, 0.9);
}

.completion-comment:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
}

.completion-comment::placeholder {
    color: var(--text-faint);
    opacity: 0.6;
    font-style: italic;
}

.tag-selection {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
}

.tag-option {
    padding: 6px 12px;
    background: var(--background-modifier-border);
    color: var(--text-muted);
    border-radius: 16px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
    user-select: none;
}

.tag-option:hover {
    background: var(--background-modifier-border-hover);
    color: var(--text-normal);
}

.tag-option.selected {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
}

.form-button-group {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    margin-top: 8px;
}

.form-button {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 80px;
}

.form-button.primary {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
}

.form-button.primary:hover {
    background: var(--interactive-accent-hover);
}

.form-button.secondary {
    background: var(--background-modifier-border);
    color: var(--text-normal);
}

.form-button.secondary:hover {
    background: var(--background-modifier-border-hover);
}

/* レスポンシブ対応 - コンテナベースの調整 */
/* 中間の幅（800px以下相当） */
.taskchute-narrow .task-item {
    /* グリッドレイアウトを調整 - プロジェクトと時間を縮小 */
    grid-template-columns: 20px 40px minmax(150px, 1fr) 120px 80px 40px 30px 30px 30px;
    gap: 4px;
}

.taskchute-narrow .task-name {
    min-width: 150px;
}

.taskchute-narrow .taskchute-project-display {
    max-width: 120px;
    margin-right: 4px;
}

.taskchute-narrow .taskchute-project-name {
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.taskchute-narrow .task-time-range {
    font-size: 11px;
}

.taskchute-narrow .routine-button,
.taskchute-narrow .comment-button {
    font-size: 13px;
}

/* さらに狭い幅（600px以下相当） */
.taskchute-very-narrow .task-item {
    /* タスク名を最優先にし、必要なボタンのみ表示 */
    grid-template-columns: 20px 40px 1fr 30px 30px;
    gap: 2px;
}

/* 表示する要素を限定 */
.taskchute-very-narrow .task-item > *:nth-child(n+6) {
    display: none;
}

/* プロジェクト、時間表示、実行時間を非表示 */
.taskchute-very-narrow .taskchute-project-display,
.taskchute-very-narrow .task-time-range,
.taskchute-very-narrow .task-duration {
    display: none;
}

/* 日跨ぎタスクのスタイル */
.task-duration.cross-day {
    color: var(--text-accent);
    font-weight: 500;
    position: relative;
}

.task-duration.cross-day::after {
    content: "🌙";
    font-size: 0.8em;
    margin-left: 4px;
    opacity: 0.7;
}

/* タスク名を最大限表示 */
.taskchute-very-narrow .task-name {
    min-width: 80px;
}

/* ルーチンボタンと設定ボタンのみ表示 */
.taskchute-very-narrow .task-item > *:nth-child(7),  /* ルーチンボタン */
.taskchute-very-narrow .task-item > *:nth-child(9) {  /* 設定ボタン */
    display: flex;
}

/* ルーチン設定モーダルの新しいスタイル */
.checkbox-group {
    display: flex;
    gap: 20px;
    margin-bottom: 10px;
}

.checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
}

.checkbox-label input[type="checkbox"] {
    cursor: pointer;
    margin: 0;
}

.weekday-checkboxes {
    display: flex;
    gap: 15px;
    flex-wrap: wrap;
    padding: 10px 0;
}

.weekday-checkbox-label {
    display: flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    user-select: none;
    padding: 5px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    transition: all 0.2s ease;
}

.weekday-checkbox-label:hover {
    background-color: var(--background-modifier-hover);
}

.weekday-checkbox-label input[type="checkbox"] {
    cursor: pointer;
    margin: 0;
}

.weekday-checkbox-label input[type="checkbox"]:checked + span {
    font-weight: bold;
    color: var(--text-accent);
}

/* 曜日選択グループ全体のスタイル */
#edit-weekday-group {
    transition: all 0.3s ease;
    overflow: hidden;
}

#edit-weekday-group[style*="display: none"] {
    max-height: 0;
    opacity: 0;
}

#edit-weekday-group[style*="display: block"] {
    max-height: 200px;
    opacity: 1;
}

/* タスク名検証スタイル */
.form-input.error {
    border-color: #e74c3c;
    background-color: #fee;
}

.task-name-warning {
    color: #e74c3c;
    font-size: 12px;
    margin-top: 4px;
    padding: 4px 8px;
    background-color: #fee;
    border-radius: 4px;
}

.task-name-warning.hidden {
    display: none;
}

.task-name-warning.highlight {
    animation: flash 0.3s ease-in-out;
}

@keyframes flash {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

.form-button.disabled {
    background-color: #ccc;
    cursor: not-allowed;
    opacity: 0.6;
}

/* Phase 1: 最下部へのドロップインジケーター */
.task-item.dragover-bottom {
    border-bottom: 2px solid var(--interactive-accent);
    margin-bottom: -2px;
}

.task-list.dragover-bottom::after {
    content: '';
    display: block;
    height: 2px;
    background-color: var(--interactive-accent);
    margin-top: 4px;
}
`;
