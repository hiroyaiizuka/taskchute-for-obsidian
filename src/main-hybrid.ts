/**
 * Hybrid Entry Point
 * 既存のmain.jsと共存するためのエントリーポイント
 * TypeScriptモジュールをグローバルに公開する
 */

// ハイブリッドブリッジをインポート（グローバルに公開される）
import './hybrid-bridge';

// エクスポートは不要（既存のmain.jsがメインプラグインとして動作）
console.log('[TaskChute] Hybrid mode initialized');