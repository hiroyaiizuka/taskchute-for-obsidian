import { initializeLocaleManager, onLocaleChange } from "../../i18n";
import type { LanguageOverride } from "../../i18n";

import type { CommandRegistrar } from "../../types/Commands";
import type { RibbonController } from "../context/PluginContext";
import { TaskChuteViewController } from "../taskchute/TaskChuteViewController";

interface LocaleCoordinatorDeps {
  commandRegistrar: CommandRegistrar;
  ribbonManager: RibbonController;
  viewController: TaskChuteViewController;
}

export class LocaleCoordinator {
  private unsubscribe?: () => void;

  constructor(private readonly deps: LocaleCoordinatorDeps) {}

  initialize(override: LanguageOverride): void {
    initializeLocaleManager(override);
    this.unsubscribe = onLocaleChange(() => {
      this.handleLocaleChange();
    });
    this.handleLocaleChange();
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private handleLocaleChange(): void {
    this.deps.commandRegistrar.relocalize();
    this.deps.ribbonManager.updateLabel();
    this.deps.viewController.applyLocaleToActiveView();
  }
}
