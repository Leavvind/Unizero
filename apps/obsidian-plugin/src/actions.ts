/**
 * What each citation form does when clicked.
 *
 * `@libraryID/itemKey` stays inside Obsidian; `.md` resolves to a vault Raw file;
 * `.pdf` / `.pdf:{page}` hand off to Zotero (optional physical page via `?page=`).
 * Conversion is the one side-effect this plugin may request: it posts to the
 * bridge's convert action, which runs the same Zotero menu command — it does
 * not edit bibliographic fields from Obsidian.
 *
 * "Raw" is the converted Markdown published for reading and light format edits
 * (by a person or an AI). It is not the hand-written note surface.
 *
 * "Canvas" is the user's real note for a paper — a vault `.canvas` they create
 * and link manually (first open picks a file; a missing path asks again).
 */

import {
  FuzzySuggestModal,
  Notice,
  TFile,
  type App,
} from "obsidian";
import { shell } from "electron";
import type { BridgePaper, UnizeroBridge } from "./bridge";
import { withPdfPage, type PaperRef } from "./citation";
import { matchRawFrontmatter } from "./rawMatch";
import type { UnizeroSettings } from "./settings";

export { matchRawFrontmatter } from "./rawMatch";
export type { RawFrontmatterMatch } from "./rawMatch";

/** Fields needed to decide Open Raw vs Convert, and to locate a vault file. */
export interface MarkdownAvailability {
  itemKey: string;
  libraryID?: number;
  citekey?: string;
  /** Collection-list / library-row flag from the bridge. */
  hasMarkdown?: boolean;
  links?: {
    markdown?: string;
    hasMarkdownAttachment: boolean;
  };
}

/** Paper identity used by Canvas links and labels. */
export type PaperIdentity = {
  libraryID: number;
  itemKey: string;
  title?: string;
  citekey?: string;
};

/** Persist a Canvas path under `settings.canvasLinks` (caller owns save). */
export type PersistCanvasLink = (key: string, path: string) => Promise<void>;

/** Settings key for a paper's Canvas path: `libraryID/itemKey`. */
export function canvasLinkKey(paper: Pick<PaperIdentity, "libraryID" | "itemKey">): string {
  return `${paper.libraryID}/${paper.itemKey}`;
}

/**
 * Find the vault Raw file for a paper.
 *
 * Path heuristics (folder + itemKey / citekey filename) run first for the
 * common layout. Frontmatter scan covers title-named publish output from
 * conversion (`{{ title }}.md`) and older files that only carry `uid` /
 * `unizero-item`.
 */
export function findRawForPaper(
  app: App,
  paper: MarkdownAvailability,
  settings: UnizeroSettings,
): TFile | undefined {
  const folder = settings.literatureFolder;
  if (folder) {
    const byKey = app.vault.getAbstractFileByPath(`${folder}/${paper.itemKey}.md`);
    if (byKey instanceof TFile) { return byKey; }
    if (paper.citekey) {
      const byCitekey = app.vault.getAbstractFileByPath(
        `${folder}/${paper.citekey}.md`,
      );
      if (byCitekey instanceof TFile) { return byCitekey; }
    }
  }

  let citekeyMatch: TFile | undefined;
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const match = matchRawFrontmatter(frontmatter, paper, settings);
    if (!match) { continue; }
    if (match === "citekeyProperty") {
      if (!citekeyMatch) { citekeyMatch = file; }
      continue;
    }
    // itemKey / uid / unizero-item are durable — return immediately.
    return file;
  }
  return citekeyMatch;
}

/** @deprecated Use {@link findRawForPaper}. */
export const findNoteForPaper = findRawForPaper;

/**
 * Open Raw vs Convert is exclusive in Obsidian menus.
 *
 * True when Zotero already has a Markdown attachment / recorded URL, or a Raw
 * file for this item already exists in the vault. Re-conversion stays a
 * Zotero-menu action so the surface does not offer both at once.
 */
export function hasMarkdownAvailable(
  app: App,
  paper: MarkdownAvailability,
  settings: UnizeroSettings,
): boolean {
  if (paper.hasMarkdown) { return true; }
  if (paper.links?.hasMarkdownAttachment || paper.links?.markdown) { return true; }
  return Boolean(findRawForPaper(app, paper, settings));
}

/**
 * Stamp conversion-compatible identity onto a vault file so later opens resolve
 * without relying on filename or Advanced URI.
 */
export async function stampRawIdentity(
  app: App,
  file: TFile,
  paper: Pick<MarkdownAvailability, "itemKey" | "libraryID" | "citekey">,
  settings: Pick<UnizeroSettings, "itemKeyProperty" | "citekeyProperty">,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm[settings.itemKeyProperty] = paper.itemKey;
    fm.uid = paper.itemKey;
    if (paper.libraryID != null) {
      fm["unizero-item"] = `${paper.libraryID}:${paper.itemKey}`;
    }
    if (paper.citekey) {
      fm[settings.citekeyProperty] = paper.citekey;
    }
  });
}

/**
 * Ask the user to pick a vault Markdown file and link it as this paper's Raw.
 *
 * Used only when Open Raw cannot resolve a file (Zotero has an attachment, but
 * the vault has no matching Raw). Not a separate menu entry.
 */
export function linkRawForPaper(
  app: App,
  paper: Pick<
    MarkdownAvailability,
    "itemKey" | "libraryID" | "citekey"
  > & { title?: string },
  settings: UnizeroSettings,
): Promise<TFile | undefined> {
  return new Promise((resolve) => {
    const label = paperLabel(paper);
    const modal = new VaultFileSuggestModal(app, {
      title: `Link Raw for ${label}`,
      placeholder: "Search Markdown files in the vault…",
      instructions:
        "Pick the converted Markdown in this vault. UniZero will write identity "
        + "frontmatter so it opens next time.",
      choosePurpose: "link as Raw",
      getItems: () => app.vault.getMarkdownFiles()
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path)),
      onChoose: async (file) => {
        try {
          await stampRawIdentity(app, file, paper, settings);
          new Notice(`Linked Raw: ${file.path}`);
          resolve(file);
        } catch (error) {
          new Notice(
            `Could not write Raw identity — ${(error as Error).message}`,
          );
          resolve(undefined);
        }
      },
      onCancel: () => resolve(undefined),
    });
    modal.open();
  });
}

export function findCanvasForPaper(
  app: App,
  paper: Pick<PaperIdentity, "libraryID" | "itemKey">,
  settings: UnizeroSettings,
): TFile | undefined {
  const path = settings.canvasLinks[canvasLinkKey(paper)];
  if (!path) { return undefined; }
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : undefined;
}

/**
 * Open the paper's Canvas note — the hand-made note surface for this paper.
 *
 * Links live in plugin settings (`canvasLinks`), not in the `.canvas` file
 * (Canvas JSON has no frontmatter). First open, or a broken path, prompts for
 * a vault `.canvas` file and remembers it until the path fails again.
 */
export async function openCanvas(
  app: App,
  paper: PaperIdentity,
  settings: UnizeroSettings,
  persistLink: PersistCanvasLink,
): Promise<void> {
  const key = canvasLinkKey(paper);
  let file = findCanvasForPaper(app, paper, settings);
  if (file) {
    await app.workspace.getLeaf(false).openFile(file);
    return;
  }

  const stale = settings.canvasLinks[key];
  const label = paperLabel(paper);
  if (stale) {
    new Notice(
      `Canvas for ${label} was “${stale}”, but that file is missing. Pick a Canvas.`,
    );
  }

  const picked = await pickCanvasFile(app, label);
  if (!picked) { return; }

  await persistLink(key, picked.path);
  new Notice(`Linked Canvas: ${picked.path}`);
  await app.workspace.getLeaf(false).openFile(picked);
}

function pickCanvasFile(app: App, label: string): Promise<TFile | undefined> {
  return new Promise((resolve) => {
    const modal = new VaultFileSuggestModal(app, {
      title: `Canvas for ${label}`,
      placeholder: "Search Canvas files in the vault…",
      instructions:
        "Pick the Obsidian Canvas that is this paper’s real note. "
        + "The path is remembered until the file is moved or deleted.",
      choosePurpose: "link Canvas",
      getItems: () => app.vault.getFiles()
        .filter((file) => file.extension === "canvas")
        .sort((a, b) => a.path.localeCompare(b.path)),
      onChoose: (file) => resolve(file),
      onCancel: () => resolve(undefined),
    });
    modal.open();
  });
}

class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
  private settled = false;

  constructor(
    app: App,
    private readonly options: {
      title: string;
      placeholder: string;
      instructions: string;
      choosePurpose: string;
      getItems: () => TFile[];
      onChoose: (file: TFile) => void | Promise<void>;
      onCancel: () => void;
    },
  ) {
    super(app);
    this.setPlaceholder(options.placeholder);
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: options.choosePurpose },
      { command: "esc", purpose: "cancel" },
    ]);
  }

  onOpen(): void {
    super.onOpen();
    this.emptyStateText = this.options.instructions;
    const withTitle = this as unknown as { setTitle?: (t: string) => void };
    withTitle.setTitle?.(this.options.title);
  }

  getItems(): TFile[] {
    return this.options.getItems();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.settled = true;
    void this.options.onChoose(file);
  }

  onClose(): void {
    super.onClose();
    if (!this.settled) {
      this.settled = true;
      this.options.onCancel();
    }
  }
}

function paperLabel(
  paper: { title?: string; libraryID?: number; itemKey: string },
): string {
  if (paper.title) { return paper.title; }
  if (paper.libraryID != null) { return `${paper.libraryID}/${paper.itemKey}`; }
  return paper.itemKey;
}

export async function openRaw(
  app: App,
  paper: BridgePaper,
  settings: UnizeroSettings,
  options: { offerLinkOnMiss?: boolean } = {},
): Promise<void> {
  const offerLink = options.offerLinkOnMiss !== false;
  const file = findRawForPaper(app, paper, settings);
  if (file) {
    await app.workspace.getLeaf(false).openFile(file);
    return;
  }

  // The add-on records a user-editable obsidian:// URL at conversion time. It may
  // point into a different vault or rely on the Advanced URI plugin, so it is the
  // fallback rather than the primary path.
  if (paper.links.markdown) {
    await openExternal(paper.links.markdown);
    return;
  }

  const label = paperLabel(paper);
  if (paper.links.hasMarkdownAttachment) {
    new Notice(
      `${label} has a Markdown attachment in Zotero, but no Raw file in this vault.`
      + (offerLink ? " Pick a file to link, or cancel." : ""),
    );
    if (offerLink) {
      const linked = await linkRawForPaper(app, paper, settings);
      if (linked) {
        await app.workspace.getLeaf(false).openFile(linked);
      }
    }
    return;
  }

  new Notice(
    `${label} has not been converted to Markdown yet. Use “Convert to Markdown”.`,
  );
}

/** @deprecated Use {@link openRaw}. */
export const openMarkdownNote = openRaw;

/**
 * Ask Zotero to run the paper-to-Markdown conversion for this item.
 *
 * The job runs in Zotero (UniZero panel); Obsidian only receives the acceptance
 * ack. After it finishes, open the Raw file again from the menu.
 */
export async function convertToMarkdown(
  bridge: UnizeroBridge,
  ref: PaperRef,
  paper?: BridgePaper,
): Promise<void> {
  const label = paper?.title || `${ref.libraryID}/${ref.itemKey}`;
  try {
    const result = await bridge.convert(ref);
    new Notice(
      result.message
      || `Conversion started for “${label}”. Watch the UniZero panel in Zotero, then open Raw again.`,
    );
  } catch (error) {
    new Notice(`UniZero: could not start conversion — ${(error as Error).message}`);
  }
}

/**
 * Open the item's PDF in Zotero.
 *
 * `page` is the 1-based physical PDF page (Zotero `?page=N`), from a
 * `@…pdf:{page}` citation. Menu / toolbar opens omit it.
 */
export async function openZoteroPdf(paper: BridgePaper, page?: number): Promise<void> {
  if (!paper.links.zoteroPdf) {
    new Notice(
      `${paper.title || `${paper.libraryID}/${paper.itemKey}`} has no PDF attachment in Zotero.`,
    );
    await openExternal(paper.links.zoteroSelect);
    return;
  }
  await openExternal(withPdfPage(paper.links.zoteroPdf, page));
}

/** Still used when a PDF is missing: jump to the item so the user can attach one. */
export async function openInZotero(paper: BridgePaper): Promise<void> {
  await openExternal(paper.links.zoteroSelect);
}

/**
 * Hand a `zotero://` or `obsidian://` URL to the OS.
 *
 * Restricted to the two schemes this plugin generates. Everything reaching here
 * came from the bridge rather than from a note, but the check keeps that true
 * even if a future caller forgets.
 */
async function openExternal(url: string): Promise<void> {
  if (!/^(zotero|obsidian):/i.test(url)) {
    new Notice("UniZero refused to open an unexpected link.");
    return;
  }
  try {
    await shell.openExternal(url);
  } catch (error) {
    new Notice(`Could not open ${url}: ${(error as Error).message}`);
  }
}
