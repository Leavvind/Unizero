import { PluginSettingTab, Setting, type App } from "obsidian";
import type UnizeroPlugin from "./main";

/** How a resolved pill labels itself. The citekey is always the tooltip. */
export type PillLabel = "citekey" | "authorYear" | "title";

export interface UnizeroSettings {
  /** Zotero's built-in HTTP server. Changing the port here matches Zotero's own. */
  endpoint: string;
  pillLabel: PillLabel;
  /** Folder searched first for `@citekey.md`. Empty means the whole vault. */
  literatureFolder: string;
  /** Frontmatter property holding a note's citekey. */
  citekeyProperty: string;
  /** Frontmatter property holding the Zotero item key — survives a citekey change. */
  itemKeyProperty: string;
}

export const DEFAULT_SETTINGS: UnizeroSettings = {
  endpoint: "http://127.0.0.1:23119",
  pillLabel: "authorYear",
  literatureFolder: "",
  citekeyProperty: "citekey",
  itemKeyProperty: "zotero-key",
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
      .setDesc("What a resolved @citekey shows inline.")
      .addDropdown((dropdown) => dropdown
        .addOption("authorYear", "Author (year)")
        .addOption("title", "Title")
        .addOption("citekey", "Citekey")
        .setValue(this.plugin.settings.pillLabel)
        .onChange(async (value) => {
          this.plugin.settings.pillLabel = value as PillLabel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("Markdown notes").setHeading();

    new Setting(containerEl)
      .setName("Literature note folder")
      .setDesc(
        "Searched first when opening @citekey.md, for a note named after the " +
        "citekey. Leave empty to search the whole vault by frontmatter.",
      )
      .addText((text) => text
        .setPlaceholder("Literature")
        .setValue(this.plugin.settings.literatureFolder)
        .onChange(async (value) => {
          this.plugin.settings.literatureFolder = value.replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Citekey property")
      .setDesc("Frontmatter property matched against the citekey.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.citekeyProperty)
        .setValue(this.plugin.settings.citekeyProperty)
        .onChange(async (value) => {
          this.plugin.settings.citekeyProperty = value.trim() ||
            DEFAULT_SETTINGS.citekeyProperty;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Zotero item key property")
      .setDesc(
        "Frontmatter property holding the Zotero item key. Preferred over the " +
        "citekey when both are present: an item key survives a metadata edit that " +
        "changes the citekey.",
      )
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.itemKeyProperty)
        .setValue(this.plugin.settings.itemKeyProperty)
        .onChange(async (value) => {
          this.plugin.settings.itemKeyProperty = value.trim() ||
            DEFAULT_SETTINGS.itemKeyProperty;
          await this.plugin.saveSettings();
        }));
  }
}
