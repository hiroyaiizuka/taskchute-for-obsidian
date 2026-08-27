import { t } from "../../../i18n"
import { toggle } from "../../controlHandlers"
import { notifyRecipeFeatureSettingsChanged } from "../../services/viewNotifications"
import type { SectionModule } from "../../types"

export const recipeSection: SectionModule = {
  items: () => [
    {
      type: "group",
      heading: t("settings.recipe.heading", "Recipes"),
      items: [
        {
          name: t("settings.recipe.enable", "Enable recipe feature"),
          desc: t(
            "settings.recipe.enableDesc",
            "Show recipe setup and management entry points in the task menu and side navigation.",
          ),
          control: {
            type: "toggle",
            key: "recipeFeatureEnabled",
            defaultValue: false,
          },
        },
      ],
    },
  ],

  handlers: {
    recipeFeatureEnabled: toggle({
      read: (settings) => settings.recipeFeatureEnabled,
      write: (settings, value) => {
        settings.recipeFeatureEnabled = value
      },
      // Open views show recipe entry points, so they have to be told.
      after: (_value, ctx) => {
        notifyRecipeFeatureSettingsChanged(ctx.app)
      },
    }),
  },
}
