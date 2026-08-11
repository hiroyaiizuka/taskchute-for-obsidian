/**
 * 月単位の排他制御をサービス横断で共有するコーディネーター。
 * reconcile / restore / rebuild が同じ monthKey で競合しないことを保証する。
 */
export class MonthSyncCoordinator {
  private static lockChains = new Map<string, Promise<void>>()

  static withMonthLock<T>(monthKey: string, fn: () => Promise<T>): Promise<T> {
    const currentChain = this.lockChains.get(monthKey) ?? Promise.resolve()

    let resolveResult!: (value: T) => void
    let rejectResult!: (reason: unknown) => void
    const resultPromise = new Promise<T>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })

    const newChain = currentChain
      .catch(() => {}) // 先行失敗で後続を詰まらせない
      .then(() => fn())
      .then(
        (result) => { resolveResult(result) },
        (error) => { rejectResult(error) },
      )
      .finally(() => {
        if (this.lockChains.get(monthKey) === newChain) {
          this.lockChains.delete(monthKey)
        }
      })

    this.lockChains.set(monthKey, newChain)
    return resultPromise
  }

  /**
   * テスト用。ロック状態を明示的に初期化する。
   */
  static _testReset(): void {
    this.lockChains.clear()
  }
}
