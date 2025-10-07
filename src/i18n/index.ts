import { en } from "./locales/en"
import { ja } from "./locales/ja"

export type LocaleKey = "en" | "ja"
export type LanguageOverride = "auto" | LocaleKey

type TranslationTree = typeof en

type TranslationDictionaries = Record<LocaleKey, TranslationTree>

type Listener = (locale: LocaleKey) => void

type Variables = Record<string, string | number>

const DICTIONARIES: TranslationDictionaries = {
  en,
  ja,
}

function normalizeLocale(input: string | null | undefined): LocaleKey {
  if (!input) return "en"
  const lowered = input.toLowerCase()
  if ((["en", "ja"] as const).includes(lowered as LocaleKey)) {
    return lowered as LocaleKey
  }
  const short = lowered.split("-")[0]
  if ((["en", "ja"] as const).includes(short as LocaleKey)) {
    return short as LocaleKey
  }
  return "en"
}

function resolveKeyPath(tree: TranslationTree, key: string): unknown {
  const segments = key.split(".").filter(Boolean)
  let current: unknown = tree
  for (const segment of segments) {
    if (
      current !== null &&
      typeof current === "object" &&
      segment in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

export function applyVariables(message: string, vars?: Variables): string {
  if (!vars) return message
  return Object.keys(vars).reduce((acc, variable) => {
    const value = String(vars[variable])
    const pattern = new RegExp(`\\{${variable}\\}`, "g")
    return acc.replace(pattern, value)
  }, message)
}

class LocaleManager {
  private current: LocaleKey = "en"
  private override: LanguageOverride = "auto"
  private listeners: Set<Listener> = new Set()

  initialize(override: LanguageOverride = "auto"): void {
    this.override = override
    const detected = this.resolveLocale(override)
    this.setLocale(detected, false)
  }

  getLocale(): LocaleKey {
    return this.current
  }

  getOverride(): LanguageOverride {
    return this.override
  }

  detectObsidianLocale(): LocaleKey {
    if (typeof window !== "undefined") {
      try {
        const stored = window.localStorage?.getItem("language")
        return normalizeLocale(stored)
      } catch {
        // Ignore access errors (Safari private mode, etc.)
      }
    }
    return "en"
  }

  resolveLocale(override: LanguageOverride): LocaleKey {
    if (override === "auto") {
      return this.detectObsidianLocale()
    }
    return override
  }

  setOverride(override: LanguageOverride): void {
    this.override = override
    const resolved = this.resolveLocale(override)
    this.setLocale(resolved)
  }

  setLocale(locale: LocaleKey, emit: boolean = true): void {
    if (this.current === locale) return
    this.current = locale
    if (emit) {
      this.listeners.forEach((listener) => {
        try {
          listener(locale)
        } catch (error) {
          console.warn("Locale listener failed", error)
        }
      })
    }
  }

  translate(key: string, vars?: Variables, fallback?: string): string {
    const primary = resolveKeyPath(DICTIONARIES[this.current], key)
    const fallbackEn = resolveKeyPath(DICTIONARIES.en, key)
    const raw = primary ?? fallbackEn ?? fallback ?? key
    if (typeof raw !== "string") {
      return typeof fallback === "string" ? fallback : key
    }
    return applyVariables(raw, vars)
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const localeManager = new LocaleManager()

export function initializeLocaleManager(override: LanguageOverride): void {
  localeManager.initialize(override)
}

export function setLocaleOverride(override: LanguageOverride): void {
  localeManager.setOverride(override)
}

export function onLocaleChange(listener: Listener): () => void {
  return localeManager.onChange(listener)
}

export function t(key: string, fallback?: string, vars?: Variables): string {
  return localeManager.translate(key, vars, fallback)
}

export function getCurrentLocale(): LocaleKey {
  return localeManager.getLocale()
}

export function translateInline(
  variants: Partial<Record<LocaleKey, string>>,
  fallback?: string,
  vars?: Variables,
): string {
  const locale = localeManager.getLocale()
  const raw = variants[locale] ?? variants.ja ?? variants.en ?? fallback
  if (typeof raw !== "string") {
    return typeof fallback === "string" ? fallback : ""
  }
  return applyVariables(raw, vars)
}
