/**
 * What each citation form does when clicked.
 *
 * `@libraryID/itemKey` stays inside Obsidian; `.md` opens the paper's Raw Markdown;
 * `.pdf` / `.pdf:{page}` hand off to Zotero (optional physical page via `?page=`).
 * Conversion is the one side-effect this plugin may request: it posts to the
 * bridge's convert action, which runs the same Zotero menu command — it does
 * not edit bibliographic fields from Obsidian.
 *
 * "Raw" is the converted paper, stored by conversion as a Markdown attachment of
 * the Zotero item (tagged `unizero:raw`) and opened with the system's Markdown
 * application. It is for reading and light format edits, not the hand-written note
 * surface.
 *
 * "Canvas" is the user's real note for a paper — a vault `.canvas` they create
 * on first open (automatically created and linked; a missing path asks again).
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
import { createCanvasForPaper } from "./canvasCreation";
import type { UnizeroSettings } from "./settings";

/** A full paper payload, or a library-pane row, as far as Open Raw vs Convert goes. */
export type RawAvailability =
  | { links: { raw?: string } }
  | { hasRaw: boolean };

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
 * Open Raw vs Convert is exclusive in Obsidian menus.
 *
 * True when the paper has a Raw attachment in Zotero. Re-conversion stays a
 * Zotero-menu action so the surface does not offer both at once.
 */
export function hasRaw(paper: RawAvailability): boolean {
  return "hasRaw" in paper
    ? paper.hasRaw
    : Boolean(paper.links.raw);
}

export function resolveCanvasFile(
  app: App,
  path: string | undefined,
): TFile | undefined {
  if (!path) { return undefined; }
  const normalized = normalizePath(path.trim());
  if (!normalized) { return undefined; }
  const file = app.vault.getAbstractFileByPath(normalized);
  return file instanceof TFile && file.extension === "canvas" ? file : undefined;
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
 * (Canvas JSON has no frontmatter). First open creates a title-named Canvas;
 * a broken path prompts for an existing file. Vault rename events keep the
 * stored path up to date.
 */
export async function openCanvas(
  app: App,
  paper: PaperIdentity,
  links: CanvasLinkStore,
): Promise<void> {
  const key = canvasLinkKey(paper);
  const existingPath = links.get(key);
  const file = resolveCanvasFile(app, existingPath);
  if (file) {
    await app.workspace.getLeaf(false).openFile(file);
    return;
  }

  const label = paperLabel(paper);
  if (!existingPath) {
    try {
      const created = await createCanvasForPaper(app, paper, links);
      await app.workspace.getLeaf(false).openFile(created);
    } catch (error) {
      console.error("UniZero: could not create or open Canvas", error);
      new Notice(`Could not create or open Canvas — ${(error as Error).message}`);
    }
    return;
  }
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
      + "The link follows file and folder renames or moves while UniZero is enabled.",
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

/**
 * Open the paper's Raw Markdown with the system's Markdown application — the same
 * thing as opening the attachment from Zotero. Without the file on this machine
 * (not yet synced down, say), select the attachment in Zotero instead.
 */
export async function openRaw(paper: BridgePaper): Promise<void> {
  const path = paper.links.rawPath;
  if (path && /\.md$/i.test(path)) {
    // openPath reports failure as a message rather than by rejecting.
    const failure = await shell.openPath(path);
    if (!failure) { return; }
    new Notice(`Could not open ${path}: ${failure}`);
  }
  if (paper.links.raw) {
    await openExternal(paper.links.raw);
    return;
  }
  new Notice(
    `${paperLabel(paper)} has no Raw in Zotero yet. Use “Convert to Markdown”.`,
  );
}

/**
 * Ask Zotero to run the paper-to-Markdown conversion for this item.
 *
 * The job runs in Zotero (UniZero panel); Obsidian only receives the acceptance
 * ack. After it finishes, open Raw from the menu.
 *
 * Cached papers are never refreshed on their own, so a menu can still offer
 * Convert after an earlier conversion finished. The paper is read again first, and
 * an existing Raw is opened instead of converting twice.
 */
export async function convertToMarkdown(
  bridge: UnizeroBridge,
  ref: PaperRef,
  paper?: BridgePaper,
): Promise<void> {
  const label = paper?.title || `${ref.libraryID}/${ref.itemKey}`;
  const current = await bridge.paper(ref).catch(() => undefined);
  if (current && hasRaw(current)) {
    await openRaw(current);
    return;
  }
  try {
    const result = await bridge.convert(ref);
    new Notice(
      result.message
      || `Conversion started for “${label}”. Watch the UniZero panel in Zotero, then open Raw.`,
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
