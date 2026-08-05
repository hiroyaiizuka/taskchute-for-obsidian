// テストは意図的に失敗パスを踏むため、src 側の console.error / warn がそのまま
// 出力されると CI ログが埋まってしまう。ここで no-op に差し替えてノイズを抑える。
// 調査したいときは TASKCHUTE_TEST_LOGS=1 を付けて実行すると従来どおり全部出る。

type SilencedMethod = 'error' | 'warn' | 'debug'

const SILENCED_METHODS: SilencedMethod[] = ['error', 'warn', 'debug']

const shouldSilence = process.env.TASKCHUTE_TEST_LOGS !== '1'

if (shouldSilence) {
  let spies: jest.SpyInstance[] = []

  beforeEach(() => {
    spies = SILENCED_METHODS.map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {}),
    )
  })

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore()
    }
    spies = []
  })
}

export {}
