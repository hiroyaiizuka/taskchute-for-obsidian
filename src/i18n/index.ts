import { getLanguage } from "obsidian"
import { en } from "./locales/en"
import { ja } from "./locales/ja"

export type LocaleKey = "en" | "ja"

type TranslationTree = typeof en

type TranslationDictionaries = Record<LocaleKey, TranslationTree>

export type Variables = Record<string, string | number>

// Every dot path from the root of the English dictionary to a string leaf.
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : Leaves<T[K], `${P}${K}.`>
}[keyof T & string]

export type TranslationKey = Leaves<TranslationTree>

// The keys under one namespace, with the namespace prefix stripped — what a
// scoped helper such as TaskChuteView#tv accepts.
export type ScopedKey<NS extends string> =
  TranslationKey extends infer K
    ? K extends `${NS}.${infer Rest}` ? Rest : never
    : never

export type ScopedTranslator<NS extends string> = (
  key: ScopedKey<NS>,
  fallback: string,
  vars?: Variables,
) => string

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

function applyVariables(message: string, vars?: Variables): string {
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

  translate(key: TranslationKey, fallback?: string, vars?: Variables): string {
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

export function t(key: TranslationKey, fallback?: string, vars?: Variables): string {
  return localeManager.translate(key, fallback, vars)
}

export function getCurrentLocale(): LocaleKey {
  return localeManager.getLocale()
}
