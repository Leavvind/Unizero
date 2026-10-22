import { PluginSettingTab, Setting, type App } from "obsidian";
import type UnizeroPlugin from "./main";

/** How a resolved pill labels itself. The written address is always in the tooltip. */
export type PillLabel = "authorYear" | "title" | "itemKey";

/** Visual treatment for inline citations; all variants follow the Obsidian theme. */
export type PillStyle = "framed" | "highlight" | "solid";

export interface UnizeroSettings {
  /** Zotero's built-in HTTP server. Changing the port here matches Zotero's own. */
  endpoint: string;
  pillLabel: PillLabel;
  pillStyle: PillStyle;
  /**
   * Conversion template a left click on Convert runs, by runtime template id.
   * Empty means Zotero's own default, so it follows the add-on if that changes.
   */
  defaultTemplate: string;
  /**
   * Legacy: `libraryID/itemKey` → vault path of a `.canvas`, from before a
   * paper's Canvas became a Zotero attachment. Nothing reads it any more; it is
   * kept so those notes can be migrated by hand.
   */
  canvasLinks: Record<string, string>;
  /**
   * Last library opened in the library pane. `null` means "pick the first
   * library the bridge returns".
   */
  lastLibraryID: number | null;
  /**
   * Last collection key in that library. Empty string means the whole library
   * (all regular items), matching Unizero Home's library-level scope.
   */
  lastCollectionKey: string;
}

export const DEFAULT_SETTINGS: UnizeroSettings = {
  endpoint: "http://127.0.0.1:23119",
  pillLabel: "authorYear",
  pillStyle: "framed",
  defaultTemplate: "",
  canvasLinks: {},
  lastLibraryID: null,
  lastCollectionKey: "",
};

export class UnizeroSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: UnizeroPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Zotero endpoint")
      .setDesc(
        "Zotero's local HTTP server. The default matches Zotero's own setting; " +
        "Zotero must be running for citations to resolve.",
      )
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.endpoint)
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (value) => {
          this.plugin.settings.endpoint = value.trim() || DEFAULT_SETTINGS.endpoint;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Check that the UniZero Zotero add-on is answering.")
      .addButton((button) => button
        .setButtonText("Test")
        .onClick(() => void this.plugin.testConnection()));

    new Setting(containerEl)
      .setName("Citation label")
      .setDesc("What a resolved citation shows inline. Notes store libraryID/itemKey.")
      .addDropdown((dropdown) => dropdown
        .addOption("authorYear", "Author (year)")
        .addOption("title", "Title")
        .addOption("itemKey", "libraryID/itemKey")
        .setValue(this.plugin.settings.pillLabel)
        .onChange(async (value) => {
          this.plugin.settings.pillLabel = value as PillLabel;
          await this.plugin.saveSettings("rerender");
        }));

    new Setting(containerEl)
      .setName("Citation style")
      .setDesc("Visual treatment for inline citations in both light and dark themes.")
      .addDropdown((dropdown) => dropdown
        .addOption("framed", "Accent frame")
        .addOption("highlight", "Soft highlight")
        .addOption("solid", "Solid accent")
        .setValue(this.plugin.settings.pillStyle)
        .onChange(async (value) => {
          this.plugin.settings.pillStyle = value as PillStyle;
          await this.plugin.saveSettings("rerender");
        }));

    this.addTemplateSetting(containerEl);

    new Setting(containerEl).setName("Canvas notes").setHeading();

    const legacy = Object.keys(this.plugin.settings.canvasLinks || {}).length;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Canvas is the hand-made note for a paper. It is stored as a .canvas "
        + "attachment of the Zotero item, like Raw; the first click in the paper "
        + "pane, library, or citation menu asks Zotero to create it empty, and it "
        + "opens with your system's handler for .canvas files."
        + (legacy
          ? ` ${legacy} older vault Canvas link${legacy === 1 ? " is" : "s are"} `
            + "still stored in this plugin's data.json for migration; "
            + "UniZero no longer opens them."
          : ""),
    });
  }

  /**
   * The list comes from the paper runtime through Zotero and only exists while
   * the runtime runs, so the saved choice is always kept as an option.
   */
  private addTemplateSetting(containerEl: HTMLElement): void {
    const saved = this.plugin.settings.defaultTemplate;
    const description =
      "What a click on Convert runs. Right-click Convert, or use “Convert with "
      + "template…”, to pick another one for a single paper.";
    const setting = new Setting(containerEl)
      .setName("Default conversion template")
      .setDesc(description);
    setting.addDropdown((dropdown) => {
      const fill = (templates: { id: string; name: string }[], zoteroDefault: string) => {
        dropdown.selectEl.empty();
        dropdown.addOption("", `Zotero default${zoteroDefault ? ` (${zoteroDefault})` : ""}`);
        for (const template of templates) {
          dropdown.addOption(template.id, template.name);
        }
        if (saved && !templates.some((template) => template.id === saved)) {
          dropdown.addOption(saved, saved);
        }
        dropdown.setValue(saved);
      };
      fill([], "");
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultTemplate = value;
        await this.plugin.saveSettings("none");
      });
      void this.plugin.bridge.templates().then(
        (listed) => {
          fill(listed.templates, listed.defaultTemplate);
          if (!listed.available) {
            setting.setDesc(
              `${description} The paper runtime is not running in Zotero, so its `
              + "templates cannot be listed yet; the saved choice is kept.",
            );
          }
        },
        () => setting.setDesc(
          `${description} Zotero is not reachable; the saved choice is kept.`,
        ),
      );
    });
  }
}
