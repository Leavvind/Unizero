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
  normalizePath,
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

/**
 * Live Canvas path store. Prefer reading through `get` on every open so a
 * caller never holds a stale `settings.canvasLinks` snapshot.
 */
export interface CanvasLinkStore {
  get(key: string): string | undefined;
  set(key: string, path: string): Promise<void>;
}

/** Settings key for a paper's Canvas path: `libraryID/itemKey`. */
export function canvasLinkKey(paper: Pick<PaperIdentity, "libraryID" | "itemKey">): string {
  return `${Number(paper.libraryID)}/${String(paper.itemKey)}`;
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
export async function linkRawForPaper(
  app: App,
  paper: Pick<
    MarkdownAvailability,
    "itemKey" | "libraryID" | "citekey"
  > & { title?: string },
  settings: UnizeroSettings,
): Promise<TFile | undefined> {
  const label = paperLabel(paper);
  const file = await pickVaultFile(app, {
    title: `Link Raw for ${label}`,
    placeholder: "Search Markdown files in the vault…",
    instructions:
      "Pick the converted Markdown in this vault. UniZero will write identity "
      + "frontmatter so it opens next time.",
    choosePurpose: "link as Raw",
    getItems: () => app.vault.getMarkdownFiles()
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
  if (!file) { return undefined; }
  try {
    await stampRawIdentity(app, file, paper, settings);
    new Notice(`Linked Raw: ${file.path}`);
    return file;
  } catch (error) {
    new Notice(`Could not write Raw identity — ${(error as Error).message}`);
    return undefined;
  }
}

export function resolveCanvasFile(
  app: App,
  path: string | undefined,
): TFile | undefined {
  if (!path) { return undefined; }
  const normalized = normalizePath(path.trim());
  if (!normalized) { return undefined; }
  const file = app.vault.getAbstractFileByPath(normalized);
  return file instanceof TFile ? file : undefined;
}

export function findCanvasForPaper(
  app: App,
  paper: Pick<PaperIdentity, "libraryID" | "itemKey">,
  links: Pick<CanvasLinkStore, "get"> | UnizeroSettings,
): TFile | undefined {
  const key = canvasLinkKey(paper);
  const path = "get" in links
    ? links.get(key)
    : links.canvasLinks?.[key];
  return resolveCanvasFile(app, path);
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
  links: CanvasLinkStore,
): Promise<void> {
  const key = canvasLinkKey(paper);
  const existingPath = links.get(key);
  let file = resolveCanvasFile(app, existingPath);
  if (file) {
    await app.workspace.getLeaf(false).openFile(file);
    return;
  }

  const label = paperLabel(paper);
  if (existingPath) {
    new Notice(
      `Canvas for ${label} was “${existingPath}”, but that file is missing. Pick a Canvas.`,
    );
  }

  const picked = await pickVaultFile(app, {
    title: `Canvas for ${label}`,
    placeholder: "Search Canvas files in the vault…",
    instructions:
      "Pick the Obsidian Canvas that is this paper’s real note. "
      + "The path is remembered until the file is moved or deleted.",
    choosePurpose: "link Canvas",
    getItems: () => app.vault.getFiles()
      .filter((entry) => entry.extension === "canvas")
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
  if (!picked) { return; }

  const path = normalizePath(picked.path);
  await links.set(key, path);
  new Notice(`Linked Canvas: ${path}`);
  await app.workspace.getLeaf(false).openFile(picked);
}

/**
 * Vault file picker. Resolves once.
 *
 * Obsidian may call `onClose` in the same turn as `onChooseItem` (or, on some
 * builds, slightly before). A synchronous cancel-in-onClose races the choice
 * and drops the file — which is exactly “I picked a Canvas, but next click
 * asks again”. Cancel is deferred so choose always wins when both fire.
 */
function pickVaultFile(
  app: App,
  options: {
    title: string;
    placeholder: string;
    instructions: string;
    choosePurpose: string;
    getItems: () => TFile[];
  },
): Promise<TFile | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (file: TFile | undefined): void => {
      if (settled) { return; }
      settled = true;
      resolve(file);
    };

    const modal = new VaultFileSuggestModal(app, {
      ...options,
      onChoose: (file) => finish(file),
      onCancel: () => finish(undefined),
    });
    modal.open();
  });
}

class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly options: {
      title: string;
      placeholder: string;
      instructions: string;
      choosePurpose: string;
      getItems: () => TFile[];
      onChoose: (file: TFile) => void;
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
    this.chosen = true;
    this.options.onChoose(file);
  }

  onClose(): void {
    super.onClose();
    // Defer cancel: onChooseItem and onClose can interleave; choose must win.
    window.setTimeout(() => {
      if (!this.chosen) {
        this.options.onCancel();
      }
    }, 0);
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
