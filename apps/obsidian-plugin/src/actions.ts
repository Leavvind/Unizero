/**
 * What each citation form does when clicked.
 *
 * `@libraryID/itemKey` stays inside Obsidian; `.md` resolves to a vault note;
 * `.pdf` hands off to Zotero. Conversion is the one side-effect this plugin may
 * request: it posts to the bridge's convert action, which runs the same Zotero
 * menu command — it does not edit bibliographic fields from Obsidian.
 */

import { Notice, TFile, type App } from "obsidian";
import { shell } from "electron";
import type { BridgePaper, UnizeroBridge } from "./bridge";
import type { PaperRef } from "./citation";
import type { UnizeroSettings } from "./settings";

/** Fields needed to decide Open note vs Convert, and to locate a vault file. */
export interface MarkdownAvailability {
  itemKey: string;
  citekey?: string;
  /** Collection-list / library-row flag from the bridge. */
  hasMarkdown?: boolean;
  links?: {
    markdown?: string;
    hasMarkdownAttachment: boolean;
  };
}

/**
 * Find the vault note for a paper.
 *
 * The item key is checked first: it is the durable half of the identity pair.
 * A citekey-named file or frontmatter field is only a fallback for notes that
 * were named that way by conversion tools.
 */
export function findNoteForPaper(
  app: App,
  paper: MarkdownAvailability,
  settings: UnizeroSettings,
): TFile | undefined {
  const folder = settings.literatureFolder;
  if (folder) {
    const byKey = app.vault.getAbstractFileByPath(`${folder}/${paper.itemKey}.md`);
    if (byKey instanceof TFile) { return byKey; }
    if (paper.citekey) {
      const byCitekey = app.vault.getAbstractFileByPath(`${folder}/${paper.citekey}.md`);
      if (byCitekey instanceof TFile) { return byCitekey; }
    }
  }

  let citekeyMatch: TFile | undefined;
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) { continue; }
    if (String(frontmatter[settings.itemKeyProperty] || "") === paper.itemKey) {
      return file;
    }
    if (!citekeyMatch && paper.citekey &&
      String(frontmatter[settings.citekeyProperty] || "") === paper.citekey) {
      citekeyMatch = file;
    }
  }
  return citekeyMatch;
}

/**
 * Open note vs Convert is exclusive in Obsidian menus.
 *
 * True when Zotero already has a Markdown attachment / recorded URL, or a note
 * for this item already exists in the vault. Re-conversion stays a Zotero-menu
 * action so the note surface does not offer both at once.
 */
export function hasMarkdownAvailable(
  app: App,
  paper: MarkdownAvailability,
  settings: UnizeroSettings,
): boolean {
  if (paper.hasMarkdown) { return true; }
  if (paper.links?.hasMarkdownAttachment || paper.links?.markdown) { return true; }
  return Boolean(findNoteForPaper(app, paper, settings));
}

export async function openMarkdownNote(
  app: App,
  paper: BridgePaper,
  settings: UnizeroSettings,
): Promise<void> {
  const file = findNoteForPaper(app, paper, settings);
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

  const label = paper.title || `${paper.libraryID}/${paper.itemKey}`;
  new Notice(paper.links.hasMarkdownAttachment
    ? `${label} has a Markdown attachment in Zotero, but no note in this vault.`
    : `${label} has not been converted to Markdown yet. Use “Convert to Markdown”.`);
}

/**
 * Ask Zotero to run the paper-to-Markdown conversion for this item.
 *
 * The job runs in Zotero (UniZero panel); Obsidian only receives the acceptance
 * ack. After it finishes, open the note again from the menu.
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
      || `Conversion started for “${label}”. Watch the UniZero panel in Zotero, then open the note again.`,
    );
  } catch (error) {
    new Notice(`UniZero: could not start conversion — ${(error as Error).message}`);
  }
}

export async function openZoteroPdf(paper: BridgePaper): Promise<void> {
  if (!paper.links.zoteroPdf) {
    new Notice(
      `${paper.title || `${paper.libraryID}/${paper.itemKey}`} has no PDF attachment in Zotero.`,
    );
    await openExternal(paper.links.zoteroSelect);
    return;
  }
  await openExternal(paper.links.zoteroPdf);
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
