// テストは意図的に失敗パスを踏むため、src 側の console 出力がそのまま流れると
// CI ログが埋まってしまう。ここで no-op に差し替えてノイズを抑える。
// 調査したいときは TASKCHUTE_TEST_LOGS=1 を付けて実行すると従来どおり全部出る。
//
// jest.spyOn ではなく直接代入しているのは意図的:
//   - setupFilesAfterEnv 評価時（各テストの import より前）に差し替わるので、
//     モジュールトップレベル・beforeAll・afterEach 後に発火する非同期コールバック
//     （浮いた Promise の catch など）からの出力も捕まえられる。
//   - jest のモックレジストリに載らないため、テスト側の jest.restoreAllMocks() /
//     resetAllMocks() で剥がれない。
// テスト側が jest.spyOn(console, 'warn') を張るケースは従来どおり動く。spy は
// 「現在の値 = この no-op」を控えて mockRestore() でそこへ戻すだけなので影響しない。

type SilencedMethod = 'error' | 'warn' | 'debug' | 'log' | 'info' | 'trace'

const SILENCED_METHODS: SilencedMethod[] = [
  'error',
  'warn',
  'debug',
  'log',
  'info',
  'trace',
]

const shouldSilence = process.env.TASKCHUTE_TEST_LOGS !== '1'

if (shouldSilence) {
  const noops = new Map<SilencedMethod, () => void>()

  const install = (): void => {
    for (const method of SILENCED_METHODS) {
      let noop = noops.get(method)
      if (!noop) {
        noop = () => {}
        noops.set(method, noop)
      }
      // テストが自前 spy を張っている最中に横取りしないよう、既に自分の no-op が
      // 載っている場合は触らない。剥がされていたときだけ貼り直す。
      if (console[method] !== noop) {
        console[method] = noop
      }
    }
  }

  install()

  // 直接代入なので restoreAllMocks では剥がれないが、テストが console を自前で
  // 書き換えたまま戻さなかった場合に備え、テスト境界で既定状態へ戻す。
  afterEach(install)
}

export {}
