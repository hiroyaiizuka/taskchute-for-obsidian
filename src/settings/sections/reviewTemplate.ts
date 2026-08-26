import { t } from "../../i18n"
import { text, validateVaultPath, vaultPath } from "../controlHandlers"
import {
  reviewFileNamePrefix,
  reviewFileNamePatternFromPrefix,
} from "../services/reviewFileNamePattern"
import type { SectionModule } from "../types"

/**
 * The file name is stored as a whole pattern but edited as just its prefix, so
 * the control binds to a key that has no matching setting; its handler does the
 * conversion in both directions.
 */
const PREFIX_KEY = "reviewFileNamePrefix"

export const reviewTemplateSection: SectionModule = {
  items: (ctx) => [
    {
      type: "group",
      heading: t("settings.reviewTemplate.heading", "Review"),
      items: [
        {
          name: t("settings.reviewTemplate.prefixName", "File name prefix"),
          desc: t("settings.reviewTemplate.prefixDesc", "Example: Review - "),
          control: {
            type: "text",
            key: PREFIX_KEY,
            defaultValue: "",
            placeholder: "Review - ",
          },
        },
        {
          name: t("settings.reviewTemplate.pathName", "Template file"),
          desc: t(
            "settings.reviewTemplate.pathDesc",
            "Path to the markdown file used as the review template.",
          ),
          control: {
            type: "file",
            key: "reviewTemplatePath",
            defaultValue: "",
            filter: (file) => file.extension === "md",
            validate: (value) => validateVaultPath(ctx, value),
          },
        },
      ],
    },
  ],

  handlers: {
    [PREFIX_KEY]: text({
      read: (settings) => reviewFileNamePrefix(settings.reviewFileNamePattern),
      write: (settings, value) => {
        settings.reviewFileNamePattern = reviewFileNamePatternFromPrefix(value)
      },
    }),
    reviewTemplatePath: vaultPath({
      read: (settings) => settings.reviewTemplatePath,
      write: (settings, value) => {
        settings.reviewTemplatePath = value
      },
      empty: null,
      kind: "file",
      missingNotice: (path) =>
        t(
          "notices.reviewTemplateMissing",
          "Review template file was not found: {path}",
          { path },
        ),
    }),
  },
}
