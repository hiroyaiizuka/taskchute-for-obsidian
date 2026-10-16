import { t } from "@/i18n"
import { DEFAULT_SETTINGS } from "../defaults"
import { choice, text, validateVaultPath, vaultPath } from "../controlHandlers"
import { isBasesKanbanSupported } from "@/features/project/services/ProjectBasesKanban"
import type { SectionModule } from "../types"

/** Where project notes are created and what they are named. */
export const projectCandidateSection: SectionModule = {
  items: (ctx) => [
    {
      type: "group",
      heading: t("settings.projectCandidates.heading", "Projects"),
      items: [
        {
          name: t(
            "settings.projectCandidates.titlePrefixName",
            "File name prefix",
          ),
          desc: t(
            "settings.projectCandidates.titlePrefixDesc",
            "Applied to project titles when creating new notes.",
          ),
          control: {
            type: "text",
            key: "projectTitlePrefix",
            defaultValue: DEFAULT_SETTINGS.projectTitlePrefix,
          },
        },
        {
          name: t(
            "settings.projectCandidates.folderName",
            "Project files location",
          ),
          desc: t(
            "settings.projectCandidates.folderDesc",
            "Folder where project notes will be saved.",
          ),
          control: {
            type: "folder",
            key: "projectsFolder",
            defaultValue: "",
            validate: (value) => validateVaultPath(ctx, value),
          },
        },
        {
          name: t("settings.projectCandidates.viewName", "Project view"),
          // Shown on every version; before 1.14 it stays on the own board and says why.
          desc: isBasesKanbanSupported()
            ? t(
                "settings.projectCandidates.viewDesc",
                "What \"Projects\" opens. A Bases kanban is a .base file in the project folder, grouped by status; it has no manual card order, and projects made from it get no prefix or template.",
              )
            : t(
                "settings.projectCandidates.viewUnsupported",
                "A Bases kanban needs Obsidian 1.14 or later.",
              ),
          control: {
            type: "dropdown",
            key: "projectBoardView",
            defaultValue: "board",
            options: {
              board: t("settings.projectCandidates.viewOptions.board", "TaskChute board"),
              bases: t("settings.projectCandidates.viewOptions.bases", "Bases kanban"),
            },
            disabled: () => !isBasesKanbanSupported(),
          },
        },
        {
          name: t("settings.projectCandidates.templateName", "Template file"),
          desc: t(
            "settings.projectCandidates.templateDesc",
            "Path to the markdown file used as the project template.",
          ),
          control: {
            type: "file",
            key: "projectTemplatePath",
            defaultValue: "",
            filter: (file) => file.extension === "md",
            validate: (value) => validateVaultPath(ctx, value),
          },
        },
      ],
    },
  ],

  handlers: {
    projectBoardView: choice<"board" | "bases">({
      read: (settings) => settings.projectBoardView,
      write: (settings, value) => {
        settings.projectBoardView = value
      },
      normalize: (raw) => (raw === "bases" ? "bases" : "board"),
    }),
    projectTitlePrefix: text({
      read: (settings) =>
        settings.projectTitlePrefix ?? DEFAULT_SETTINGS.projectTitlePrefix,
      write: (settings, value) => {
        settings.projectTitlePrefix = value
      },
    }),
    projectsFolder: vaultPath({
      read: (settings) => settings.projectsFolder,
      write: (settings, value) => {
        settings.projectsFolder = value
      },
      empty: null,
      kind: "folder",
      missingNotice: (path) =>
        t("settings.validation.missingFolder", "Folder was not found: {path}", {
          path,
        }),
    }),
    projectTemplatePath: vaultPath({
      read: (settings) => settings.projectTemplatePath,
      write: (settings, value) => {
        settings.projectTemplatePath = value
      },
      empty: null,
      kind: "file",
      missingNotice: (path) =>
        t(
          "notices.projectTemplateMissing",
          "Project template file was not found: {path}",
          { path },
        ),
    }),
  },
}
