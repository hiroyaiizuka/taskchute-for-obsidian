import { t } from "../../i18n"

export class RibbonManager {
  private ribbonIconEl?: HTMLElement

  constructor(
    private readonly addIcon: (iconId: string, title: string, callback: () => void | Promise<void>) => HTMLElement,
    private readonly onClick: () => void | Promise<void>,
  ) {}

  initialize(): void {
    const label = this.getLabel()
    this.ribbonIconEl = this.addIcon("checkmark", label, () => {
      void this.onClick()
    })
    this.updateLabel()
  }

  updateLabel(): void {
    if (!this.ribbonIconEl) return
    const label = this.getLabel()
    const ribbon = this.ribbonIconEl as HTMLElement & {
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

  private getLabel(): string {
    return t("commands.openView", "Open TaskChute")
  }
}
