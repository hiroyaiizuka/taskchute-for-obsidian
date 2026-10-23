import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  orphanStorePath,
  readOrphans,
  updateOrphans,
} from '@/features/ai-task/services/BrokerOrphanStore'

const trusted = () => true

describe('BrokerOrphanStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'taskchute-orphans-'))
    path = orphanStorePath(join(dir, 'taskchute-plus-ai-broker-x.json'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('pending terminations survive a round trip, without the broker token', () => {
    updateOrphans(fs, path, trusted, { add: [{ sessionId: 'session-a', pid: 123, port: 4567 }] })
    expect(readOrphans(fs, path, trusted)).toEqual([
      { sessionId: 'session-a', pid: 123, port: 4567 },
    ])
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path, 'utf8')).not.toContain('token')
  })

  test('settling the last record removes the file', () => {
    updateOrphans(fs, path, trusted, { add: [{ sessionId: 'session-a', pid: 123, port: 4567 }] })
    updateOrphans(fs, path, trusted, { remove: ['session-a'] })
    expect(fs.existsSync(path)).toBe(false)
  })

  test('two client generations never erase each other\'s records', () => {
    // The client kept by an old terminal handle, and the one a hot reload made.
    const older = { sessionId: 'session-a', pid: 123, port: 4567 }
    const newer = { sessionId: 'session-b', pid: 123, port: 4567 }
    updateOrphans(fs, path, trusted, { add: [older] })
    updateOrphans(fs, path, trusted, { add: [newer] })
    // The older client confirms its own session only.
    updateOrphans(fs, path, trusted, { remove: ['session-a'] })
    expect(readOrphans(fs, path, trusted)).toEqual([newer])
  })

  test('a temporary entry planted in advance is never followed or truncated', () => {
    const victim = join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'keep me')
    const realNow = Date.now
    const realRandom = Math.random
    // Pin the first temporary name and plant a symlink there.
    Date.now = () => 0
    let calls = 0
    Math.random = () => (calls++ === 0 ? 0.5 : realRandom())
    try {
      const planted = `${path}.0${(0.5).toString(36).slice(2)}.tmp`
      fs.symlinkSync(victim, planted)
      updateOrphans(fs, path, trusted, { add: [{ sessionId: 'session-a', pid: 123, port: 4567 }] })
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep me')
      expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true)
      expect(fs.lstatSync(path).isSymbolicLink()).toBe(false)
      expect(readOrphans(fs, path, trusted)).toHaveLength(1)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
  })

  test('a missing, untrusted or malformed file yields nothing', () => {
    expect(readOrphans(fs, path, trusted)).toEqual([])
    updateOrphans(fs, path, trusted, { add: [{ sessionId: 'session-a', pid: 123, port: 4567 }] })
    expect(readOrphans(fs, path, () => false)).toEqual([])
    fs.writeFileSync(path, '[{"sessionId":"","pid":-1,"port":99999}, "x"]', { mode: 0o600 })
    expect(readOrphans(fs, path, trusted)).toEqual([])
  })
})
