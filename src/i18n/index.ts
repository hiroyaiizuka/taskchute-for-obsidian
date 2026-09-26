import { getLanguage } from "obsidian"
import { en } from "./locales/en"
import { ja } from "./locales/ja"

export type LocaleKey = "en" | "ja"

type TranslationTree = typeof en

type TranslationDictionaries = Record<LocaleKey, TranslationTree>

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

// The plugin always speaks Obsidian's language. Obsidian only changes language
// across a restart, so the locale is read once at load and never changes while
// the plugin is running — there is nothing to re-localize.
class LocaleManager {
  private current: LocaleKey = "en"

  initialize(): void {
    this.current = normalizeLocale(getLanguage())
  }

  getLocale(): LocaleKey {
    return this.current
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
}

export const localeManager = new LocaleManager()

export function initializeLocaleManager(): void {
  localeManager.initialize()
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
