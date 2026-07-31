/**
 * What each citation form does when clicked.
 *
 * `@libraryID/itemKey` stays inside Obsidian; `.md` resolves to a vault note;
 * `.pdf` hands off to Zotero. The two handoffs are one-way on purpose — this
 * plugin opens things in Zotero and never asks Zotero to change anything.
 */

import { Notice, TFile, type App } from "obsidian";
import { shell } from "electron";
import type { BridgePaper } from "./bridge";
import type { UnizeroSettings } from "./settings";

/**
 * Find the vault note for a paper.
 *
 * The item key is checked first: it is the durable half of the identity pair.
 * A citekey-named file or frontmatter field is only a fallback for notes that
 * were named that way by conversion tools.
 */
export function findNoteForPaper(
  app: App,
  paper: BridgePaper,
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
    : `${label} has not been converted to Markdown yet.`);
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
