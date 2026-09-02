/**
 * The one predicate that decides whether terminal mode is on the table.
 *
 * Two entry points answer it — the gateway holds `process.platform`, the
 * settings tab holds only Obsidian's Platform — and they must never disagree,
 * because the settings tab uses its answer to decide whether to offer a mode
 * that AiTaskManager would silently refuse.
 */
import { Platform } from 'obsidian'
import {
  isPtyPlatformSupported,
  isTerminalModeSupportedHere,
} from '../../../src/features/ai-task/services/ptyPlatform'

describe('isPtyPlatformSupported', () => {
  test('accepts the platforms that ship script(1)', () => {
    expect(isPtyPlatformSupported('darwin')).toBe(true)
    expect(isPtyPlatformSupported('linux')).toBe(true)
  })

  test('rejects Windows and anything unrecognized', () => {
    expect(isPtyPlatformSupported('win32')).toBe(false)
    expect(isPtyPlatformSupported('freebsd')).toBe(false)
    expect(isPtyPlatformSupported('')).toBe(false)
  })
})

describe('isTerminalModeSupportedHere', () => {
  const original = {
    isDesktop: Platform.isDesktop,
    isMacOS: Platform.isMacOS,
    isLinux: Platform.isLinux,
  }

  afterEach(() => {
    Platform.isDesktop = original.isDesktop
    Platform.isMacOS = original.isMacOS
    Platform.isLinux = original.isLinux
  })

  test('agrees with the string predicate on every desktop platform', () => {
    Platform.isDesktop = true

    Platform.isMacOS = true
    Platform.isLinux = false
    expect(isTerminalModeSupportedHere()).toBe(isPtyPlatformSupported('darwin'))

    Platform.isMacOS = false
    Platform.isLinux = true
    expect(isTerminalModeSupportedHere()).toBe(isPtyPlatformSupported('linux'))

    Platform.isLinux = false
    expect(isTerminalModeSupportedHere()).toBe(isPtyPlatformSupported('win32'))
  })

  test('refuses mobile even when the OS family would qualify', () => {
    Platform.isDesktop = false
    Platform.isMacOS = true
    Platform.isLinux = false
    expect(isTerminalModeSupportedHere()).toBe(false)
  })
})
