import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  orphanStorePath,
  readOrphans,
  writeOrphans,
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
    writeOrphans(fs, path, [{ sessionId: 'session-a', pid: 123, port: 4567 }])
    expect(readOrphans(fs, path, trusted)).toEqual([
      { sessionId: 'session-a', pid: 123, port: 4567 },
    ])
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path, 'utf8')).not.toContain('token')
  })

  test('an empty list removes the file', () => {
    writeOrphans(fs, path, [{ sessionId: 'session-a', pid: 123, port: 4567 }])
    writeOrphans(fs, path, [])
    expect(fs.existsSync(path)).toBe(false)
  })

  test('a missing, untrusted or malformed file yields nothing', () => {
    expect(readOrphans(fs, path, trusted)).toEqual([])
    writeOrphans(fs, path, [{ sessionId: 'session-a', pid: 123, port: 4567 }])
    expect(readOrphans(fs, path, () => false)).toEqual([])
    fs.writeFileSync(path, '[{"sessionId":"","pid":-1,"port":99999}, "x"]', { mode: 0o600 })
    expect(readOrphans(fs, path, trusted)).toEqual([])
  })
})
