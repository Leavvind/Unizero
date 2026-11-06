import { PluginSettingTab, Setting, type App } from "obsidian";
import {
  CAPTURE_MODE_LABELS,
  CAPTURE_MODES,
  isCaptureMode,
  type CaptureMode,
} from "./capture/canvasCapture";
import type UnizeroPlugin from "./main";
import { coverageSummary } from "./backlinksView";

export interface UnizeroSettings {
  /** Zotero's built-in HTTP server. Changing the port here matches Zotero's own. */
  endpoint: string;
  vaultID: string;
  uidProperty: string;
  uidSource: "property" | "filename";
  uidFilenamePattern: string;
  indexZoteroSources: boolean;
  sourceLibraryIDs: number[];
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
  /**
   * The library pane lists a collection's subcollection papers too, like
   * Zotero's "Show Items from Subcollections".
   */
  showSubcollectionItems: boolean;
  /** How Zotero excerpts reach Canvas text Cards; off unless the user picks one. */
  captureMode: CaptureMode;
}

export const DEFAULT_SETTINGS: UnizeroSettings = {
  endpoint: "http://127.0.0.1:23119",
  vaultID: "",
  uidProperty: "uid",
  uidSource: "property",
  uidFilenamePattern: "",
  indexZoteroSources: false,
  sourceLibraryIDs: [],
  defaultTemplate: "",
  canvasLinks: {},
  lastLibraryID: null,
  lastCollectionKey: "",
  showSubcollectionItems: true,
  captureMode: "off",
};

export class UnizeroSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: UnizeroPlugin) {
    super(app, plugin);
  }

  private unsubscribeCoverage?: () => void;

  hide(): void {
    this.unsubscribeCoverage?.();
    this.unsubscribeCoverage = undefined;
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

    new Setting(containerEl).setName("Document identity").setHeading();
    new Setting(containerEl).setName("Vault identity").setDesc(`ID: ${this.plugin.settings.vaultID}. Sync this plugin's settings between devices.`)
      .addButton((button) => button.setButtonText("Treat as a new Vault…").onClick(() => { void this.plugin.newVaultIdentity(); }));
    new Setting(containerEl).setName("UID source").setDesc("Where each note's UID comes from. A note without one gets a timestamp UID when you link to it or assign one.")
      .addDropdown((dropdown) => dropdown.addOption("property", "Frontmatter property").addOption("filename", "Filename capture group")
        .setValue(this.plugin.settings.uidSource).onChange(async (value) => {
          this.plugin.settings.uidSource = value as "property" | "filename"; await this.plugin.saveSettings("none"); await this.plugin.vaultIndex.initialize();
        }));
    new Setting(containerEl).setName("UID property").addText((text) => text.setValue(this.plugin.settings.uidProperty).onChange(async (value) => {
      this.plugin.settings.uidProperty = value.trim() || "uid"; await this.plugin.saveSettings("none"); await this.plugin.vaultIndex.initialize();
    }));
    new Setting(containerEl).setName("Filename UID pattern").setDesc("Filename source only: a regular expression with one capture group.")
      .addText((text) => text.setValue(this.plugin.settings.uidFilenamePattern).onChange(async (value) => {
        this.plugin.settings.uidFilenamePattern = value; await this.plugin.saveSettings("none"); await this.plugin.vaultIndex.initialize();
      }));
    new Setting(containerEl).setName("Index Zotero documents").setDesc("Also index links in local Markdown and Canvas attachments. Refreshes every minute.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.indexZoteroSources).onChange(async (value) => {
        this.plugin.settings.indexZoteroSources = value; await this.plugin.saveSettings("none"); await this.plugin.configureExternalIndex();
      }));
    new Setting(containerEl).setName("Source libraries").setDesc("Comma-separated library IDs; empty means all.")
      .addText((text) => text.setValue(this.plugin.settings.sourceLibraryIDs.join(",")).onChange(async (value) => {
        const ids = value.trim() ? value.split(",").map((part) => Number(part.trim())) : [];
        if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) { return; }
        this.plugin.settings.sourceLibraryIDs = [...new Set(ids)]; await this.plugin.saveSettings("none"); await this.plugin.configureExternalIndex();
      }));
    const refresh = new Setting(containerEl).setName("Refresh document links").addButton((button) => button.setButtonText("Rebuild").onClick(() => { void this.plugin.refreshLinks(true); }));
    // The status follows the index while this tab is open.
    const describe = () => refresh.setDesc(`Links refresh automatically. Status: ${coverageSummary(this.plugin)}.`);
    describe();
    this.unsubscribeCoverage?.();
    this.unsubscribeCoverage = this.plugin.vaultIndex.links.subscribe(describe);

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

    new Setting(containerEl)
      .setName("Canvas capture")
      .setDesc(
        "Send Zotero annotations into Canvas text Cards or Markdown notes as "
        + "“excerpt [Author, Year](zotero://…)”. The link records where the excerpt "
        + "came from and is not a citation, so it is not counted in the Links tab. "
        + "Quicker: click the “Capture:” status bar item, or bind a hotkey to "
        + "“Canvas capture: Toggle auto capture”.",
      )
      .addDropdown((dropdown) => {
        for (const mode of CAPTURE_MODES) {
          dropdown.addOption(mode, CAPTURE_MODE_LABELS[mode]);
        }
        dropdown
          .setValue(this.plugin.settings.captureMode)
          .onChange(async (value) => {
            if (isCaptureMode(value)) { await this.plugin.capture.setMode(value); }
          });
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
