import { t } from "../../../i18n"
import type { SectionModule } from "../../types"
import { externalToolsSection } from "./externalTools"
import { recipeSection } from "./recipe"
import { sectionCustomizationSection } from "./sectionCustomization"
import type { SectionBoundaryDraft } from "./sectionBoundaryDraft"
import { taskCreationSection } from "./taskCreation"
import { timeSlotsSection } from "./timeSlots"

/** Folds one kind of handler map from each part into a single map. */
function mergeHandlers<T extends Record<string, unknown>>(
  parts: readonly SectionModule[],
  pick: (part: SectionModule) => T | undefined,
): T {
  return parts.reduce<T>(
    (merged, part) => ({ ...merged, ...(pick(part) ?? {}) }),
    {} as T,
  )
}

/**
 * Settings that are set once and then left alone.
 *
 * A navigable sub-page rather than the collapsed `details` block it used to be:
 * the declarative API has no collapsible group, and a page has the advantage
 * that its contents still reach the settings search.
 */
export function advancedSection(draft: SectionBoundaryDraft): SectionModule {
  const parts: SectionModule[] = [
    taskCreationSection,
    recipeSection,
    sectionCustomizationSection(draft),
    timeSlotsSection,
    externalToolsSection,
  ]

  return {
    items: (ctx) => [
      {
        type: "page",
        name: t("settings.advanced.heading", "Advanced settings"),
        items: parts.flatMap((part) => part.items(ctx)),
      },
    ],
    handlers: mergeHandlers(parts, (part) => part.handlers),
    prefixHandlers: mergeHandlers(parts, (part) => part.prefixHandlers),
  }
}
