import { Notice } from "obsidian"
import { t } from "../../../i18n"
import { showConfirmModal } from "../../../ui/modals/ConfirmModal"
import {
  applySectionCustomization,
  isDefaultBoundaries,
  isUnchangedBoundaries,
  validateBoundaries,
} from "../../services/sectionCustomizationService"
import type { SectionContext, SectionModule } from "../../types"
import {
  SectionBoundaryDraft,
  parseBoundary,
} from "./sectionBoundaryDraft"

/** Boundary rows are numbered, so their keys are only known at render time. */
const KEY_PREFIX = "sectionBoundary"

/** Below this many boundaries the day stops dividing into sections at all. */
const MINIMUM_BOUNDARIES = 2

async function applyDraft(
  ctx: SectionContext,
  draft: SectionBoundaryDraft,
): Promise<void> {
  // Times are entered in any order and sorted on the way in, so the user never
  // has to keep the list ordered while editing.
  draft.sort()
  ctx.update()

  const validationError = validateBoundaries(draft.list)
  if (validationError) {
    new Notice(validationError)
    return
  }

  if (isUnchangedBoundaries(draft.list, ctx.plugin)) {
    new Notice(
      t("settings.advanced.sectionCustomize.noChanges", "No changes to apply"),
    )
    return
  }

  const confirmed = await showConfirmModal(ctx.app, {
    title: t(
      "settings.advanced.sectionCustomize.confirmDialog.title",
      "Change section boundaries",
    ),
    message: t(
      "settings.advanced.sectionCustomize.confirmDialog.body",
      "Changing section boundaries will recalculate slot assignments for existing tasks. Continue?",
    ),
    confirmText: t(
      "settings.advanced.sectionCustomize.confirmDialog.confirm",
      "Apply",
    ),
    cancelText: t(
      "settings.advanced.sectionCustomize.confirmDialog.cancel",
      "Cancel",
    ),
  })
  if (!confirmed) return

  // Storing undefined rather than a copy of the defaults keeps "unchanged"
  // meaning the same thing after a future change to the default boundaries.
  const boundaries = isDefaultBoundaries(draft.list)
    ? undefined
    : draft.snapshot()

  try {
    await applySectionCustomization(ctx.plugin, boundaries)
    draft.reseed(ctx.plugin.settings.customSections)
    ctx.update()
    new Notice(
      t(
        "settings.advanced.sectionCustomize.applied",
        "Section boundaries updated",
      ),
    )
  } catch (error) {
    console.error("[SettingsTab] section customization failed", error)
    new Notice(
      t(
        "settings.advanced.sectionCustomize.migrationFailed",
        "An error occurred while recalculating slot assignments",
      ),
    )
  }
}

/**
 * The boundaries that divide the day into sections.
 *
 * Edits accumulate in a draft and only reach the settings on Apply, because
 * applying rewrites every task's slot assignment — not something to do on each
 * keystroke.
 */
export function sectionCustomizationSection(
  draft: SectionBoundaryDraft,
): SectionModule {
  return {
    items: (ctx) => {
      draft.ensureSeeded(ctx.plugin.settings.customSections)
      return [
        {
          type: "list",
          heading: t(
            "settings.advanced.sectionCustomize.heading",
            "Section customization",
          ),
          items: draft.list.map((_boundary, index) => ({
            name: t(
              "settings.advanced.sectionCustomize.boundaryLabel",
              `Boundary ${index + 1}`,
              { index: index + 1 },
            ),
            control: {
              type: "text" as const,
              key: `${KEY_PREFIX}.${index}`,
              placeholder: "hh:mm",
              validate: (value: string) =>
                parseBoundary(value)
                  ? undefined
                  : t(
                      "settings.advanced.sectionCustomize.validation.invalidFormat",
                      "Please enter in HH:MM format",
                    ),
            },
          })),
          // Withheld at the minimum so the last removable row loses its delete
          // affordance rather than failing when used.
          onDelete:
            draft.list.length > MINIMUM_BOUNDARIES
              ? (index: number) => {
                  draft.removeAt(index)
                  ctx.update()
                }
              : undefined,
          addItem: {
            name: t(
              "settings.advanced.sectionCustomize.addBoundary",
              "Add boundary",
            ),
            action: () => {
              draft.add()
              ctx.update()
            },
          },
        },
        {
          name: t(
            "settings.advanced.sectionCustomize.resetDefault",
            "Reset to default",
          ),
          action: () => {
            draft.resetToDefault()
            ctx.update()
          },
        },
        {
          name: t("settings.advanced.sectionCustomize.apply", "Apply"),
          desc: t(
            "settings.advanced.sectionCustomize.migrationNotice",
            "Changing section boundaries will automatically recalculate slot assignments for existing tasks.",
          ),
          action: () => {
            void applyDraft(ctx, draft)
          },
        },
      ]
    },

    prefixHandlers: {
      [KEY_PREFIX]: (suffix) => {
        const index = Number(suffix)
        if (!Number.isInteger(index)) return undefined
        return {
          // Seeded here as well as while building items: a control's value can
          // be read before the first render, and an unseeded draft would answer
          // with nothing and swallow the write that follows.
          read: (ctx) => {
            draft.ensureSeeded(ctx.plugin.settings.customSections)
            return draft.format(index)
          },
          // Draft only: nothing is persisted until Apply.
          write: (value, ctx) => {
            draft.ensureSeeded(ctx.plugin.settings.customSections)
            const boundary = parseBoundary(String(value))
            if (boundary) draft.set(index, boundary)
          },
        }
      },
    },
  }
}
