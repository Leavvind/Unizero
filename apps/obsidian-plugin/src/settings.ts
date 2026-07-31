import { PluginSettingTab, Setting, type App } from "obsidian";
import type UnizeroPlugin from "./main";

/** How a resolved pill labels itself. The written address is always in the tooltip. */
export type PillLabel = "authorYear" | "title" | "itemKey";

export interface UnizeroSettings {
  /** Zotero's built-in HTTP server. Changing the port here matches Zotero's own. */
  endpoint: string;
  pillLabel: PillLabel;
  /** Folder searched first for literature notes. Empty means the whole vault. */
  literatureFolder: string;
  /** Frontmatter property holding a note's citekey (fallback match). */
  citekeyProperty: string;
  /** Frontmatter property holding the Zotero item key — preferred match. */
  itemKeyProperty: string;
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
  literatureFolder: "",
  citekeyProperty: "citekey",
  itemKeyProperty: "zotero-key",
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
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("Markdown notes").setHeading();

    new Setting(containerEl)
      .setName("Literature note folder")
      .setDesc(
        "Searched first when opening a .md citation, for a note named after the " +
        "item key (or citekey). Leave empty to search the whole vault by frontmatter.",
      )
      .addText((text) => text
        .setPlaceholder("Literature")
        .setValue(this.plugin.settings.literatureFolder)
        .onChange(async (value) => {
          this.plugin.settings.literatureFolder = value.replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Zotero item key property")
      .setDesc(
        "Frontmatter property holding the Zotero item key. Preferred when matching " +
        "vault notes to papers.",
      )
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.itemKeyProperty)
        .setValue(this.plugin.settings.itemKeyProperty)
        .onChange(async (value) => {
          this.plugin.settings.itemKeyProperty = value.trim() ||
            DEFAULT_SETTINGS.itemKeyProperty;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Citekey property")
      .setDesc("Frontmatter property matched as a fallback against the citekey.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.citekeyProperty)
        .setValue(this.plugin.settings.citekeyProperty)
        .onChange(async (value) => {
          this.plugin.settings.citekeyProperty = value.trim() ||
            DEFAULT_SETTINGS.citekeyProperty;
          await this.plugin.saveSettings();
        }));
  }
}
