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
   * Folder searched first for Raw Markdown (converted papers). Empty means
   * path heuristics are skipped and the whole vault is matched by frontmatter.
   */
  literatureFolder: string;
  /** Frontmatter property holding a Raw file's citekey (fallback match). */
  citekeyProperty: string;
  /**
   * Frontmatter property holding the Zotero item key. Preferred match; also
   * written when Open Raw has to pick a vault file. Conversion itself writes
   * `uid` / `unizero-item`.
   */
  itemKeyProperty: string;
  /**
   * Hand-linked Canvas notes: `libraryID/itemKey` → vault path of a `.canvas`
   * file. Canvas is the real note surface; paths are set on first open (or
   * when a stored path is missing).
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
  literatureFolder: "",
  citekeyProperty: "citekey",
  itemKeyProperty: "zotero-key",
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

    new Setting(containerEl).setName("Raw Markdown").setHeading();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Raw is the converted paper Markdown for reading and format correction "
        + "(human or AI) — not the hand-written note. Conversion writes uid and "
        + "unizero-item. If Open Raw cannot find a file but Zotero has a Markdown "
        + "attachment, you are prompted to pick one in the vault.",
    });

    new Setting(containerEl)
      .setName("Raw folder")
      .setDesc(
        "Searched first when opening a .md citation, for a file named after the "
        + "item key (or citekey). Leave empty to search the whole vault by "
        + "frontmatter (uid, unizero-item, or the properties below). "
        + "Often matches the conversion publish destination (e.g. 20_Papers).",
      )
      .addText((text) => text
        .setPlaceholder("20_Papers")
        .setValue(this.plugin.settings.literatureFolder)
        .onChange(async (value) => {
          this.plugin.settings.literatureFolder = value.replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings("none");
        }));

    new Setting(containerEl)
      .setName("Zotero item key property")
      .setDesc(
        "Frontmatter property holding the Zotero item key. Preferred when matching "
        + "vault Raw files to papers; also written when Open Raw picks a file.",
      )
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.itemKeyProperty)
        .setValue(this.plugin.settings.itemKeyProperty)
        .onChange(async (value) => {
          this.plugin.settings.itemKeyProperty = value.trim() ||
            DEFAULT_SETTINGS.itemKeyProperty;
          await this.plugin.saveSettings("none");
        }));

    new Setting(containerEl)
      .setName("Citekey property")
      .setDesc(
        "Frontmatter property matched as a fallback against the citekey "
        + "(also written when Open Raw picks a file, when known).",
      )
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.citekeyProperty)
        .setValue(this.plugin.settings.citekeyProperty)
        .onChange(async (value) => {
          this.plugin.settings.citekeyProperty = value.trim() ||
            DEFAULT_SETTINGS.citekeyProperty;
          await this.plugin.saveSettings("none");
        }));

    new Setting(containerEl).setName("Canvas notes").setHeading();

    const linked = Object.keys(this.plugin.settings.canvasLinks || {}).length;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Canvas is the hand-made note for a paper. Paper pane / library / "
        + "citation menus open it; the first click (or a missing path) asks "
        + "you to pick a .canvas file. "
        + (linked
          ? `${linked} paper${linked === 1 ? "" : "s"} currently linked in this vault.`
          : "No Canvas links stored yet."),
    });
  }
}
