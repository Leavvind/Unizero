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
   * Canvas notes: `libraryID/itemKey` → vault path of a `.canvas`
   * file. Canvas is the real note surface; paths are set on first open (or
   * when a stored path is missing), and follow vault file/folder rename events.
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

    new Setting(containerEl).setName("Canvas notes").setHeading();

    const linked = Object.keys(this.plugin.settings.canvasLinks || {}).length;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Canvas is the hand-made note for a paper. Paper pane / library / "
        + "citation menus open it; the first click creates and links a Canvas "
        + "named after the paper in Obsidian's configured new-note location. "
        + "A missing linked file asks you to pick its new location. "
        + "Links follow file and folder renames or moves while UniZero is enabled. "
        + (linked
          ? `${linked} paper${linked === 1 ? "" : "s"} currently linked in this vault.`
          : "No Canvas links stored yet."),
    });
  }
}
