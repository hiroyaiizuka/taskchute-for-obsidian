import { t } from "@/i18n"

export class RibbonManager {
  constructor(
    private readonly addIcon: (iconId: string, title: string, callback: () => void | Promise<void>) => HTMLElement,
    private readonly onClick: () => void | Promise<void>,
  ) {}

  initialize(): void {
    const label = t("commands.openView", "Open TaskChute")
    const ribbon = this.addIcon("checkmark", label, () => {
      void this.onClick()
    }) as HTMLElement & {
      setAttr?: (key: string, value: string) => void
    }

    if (typeof ribbon.setAttr === "function") {
      ribbon.setAttr("aria-label", label)
      ribbon.setAttr("aria-label-position", "right")
      ribbon.setAttr("data-tooltip", label)
    } else {
      ribbon.setAttribute("aria-label", label)
      ribbon.setAttribute("data-tooltip", label)
    }
    ribbon.setAttribute("title", label)
  }
}
