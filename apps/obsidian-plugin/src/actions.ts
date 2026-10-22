/**
 * What each citation form does when clicked.
 *
 * `@libraryID/itemKey` stays inside Obsidian; `.md` opens the paper's Raw Markdown;
 * `.pdf` / `.pdf:{page}` hand off to Zotero (optional physical page via `?page=`).
 * Side-effects the plugin may request all concern the user's own artifacts:
 * conversion (the same Zotero menu command), creating the empty Canvas on first
 * open, moving Raw or Canvas to Zotero's trash, and restoring Raw from Raw Backup.
 * A move to the trash or a replacement is confirmed first, and nothing is erased.
 * None edits bibliographic fields from Obsidian.
 *
 * "Raw" is the converted paper, stored by conversion as a Markdown attachment of
 * the Zotero item (tagged `unizero:raw`) and opened with the system's Markdown
 * application. It is for reading and light format edits, not the hand-written note
 * surface.
 *
 * "Canvas" is the user's real note for a paper — a `.canvas` stored, like Raw, as
 * an attachment of the Zotero item (tagged `unizero:canvas`). Zotero creates it
 * empty on the first open; it opens with the system's handler for `.canvas`.
 */

import { Menu, Notice, type App } from "obsidian";
import { shell } from "electron";
import type {
  BridgeCanvas,
  BridgeCollectionItem,
  BridgePaper,
  UnizeroBridge,
} from "./bridge";
import { choose, confirm } from "./choiceModal";
import { withPdfPage, type PaperRef } from "./citation";
import { templateMenuEntries } from "./templates";

/** A full paper payload, or a library-pane row, as far as Open Raw vs Convert goes. */
export type RawAvailability =
  | { links: { raw?: string } }
  | { hasRaw: boolean };

/** Paper identity used by Canvas opens and labels. */
export type PaperIdentity = {
  libraryID: number;
  itemKey: string;
  title?: string;
  citekey?: string;
};

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

/**
 * What the Raw and Canvas actions need beyond the paper: the app for dialogs, the
 * bridge, and a way to tell every open view that a paper's artifacts changed.
 */
export interface ActionContext {
  app: App;
  bridge: UnizeroBridge;
  /** The Default conversion template setting; empty means Zotero's own default. */
  defaultTemplate: string;
  /** Called after Zotero created, trashed, or replaced a paper's Raw or Canvas. */
  changed(ref: PaperRef): void;
}

/** Which of the user's own artifacts a paper has, from a payload or a library row. */
export interface ArtifactState {
  hasRaw: boolean;
  hasRawBackup: boolean;
  hasCanvas: boolean;
}

export function artifactState(paper: BridgePaper | BridgeCollectionItem): ArtifactState {
  return "links" in paper
    ? {
      hasRaw: Boolean(paper.links.raw),
      hasRawBackup: Boolean(paper.links.rawBackup),
      hasCanvas: Boolean(paper.links.canvas),
    }
    : {
      hasRaw: paper.hasRaw,
      hasRawBackup: Boolean(paper.hasRawBackup),
      hasCanvas: Boolean(paper.hasCanvas),
    };
}

function refOf(paper: PaperIdentity): PaperRef {
  return { libraryID: paper.libraryID, itemKey: paper.itemKey };
}

/**
 * Open the paper's Canvas note — the hand-made note surface for this paper.
 *
 * Zotero answers with the paper's Canvas attachment, creating an empty one on the
 * first open, so a stale cached paper never offers a second Canvas. The file opens
 * with the system's handler for `.canvas`, as it does from Zotero. Without the file
 * on this machine, the user chooses between waiting for sync (show it in Zotero)
 * and replacing it with a new empty Canvas.
 */
export async function openCanvas(
  context: ActionContext,
  paper: PaperIdentity,
): Promise<void> {
  let canvas: BridgeCanvas;
  try {
    canvas = await context.bridge.canvas(refOf(paper));
  } catch (error) {
    new Notice(`UniZero: could not open the Canvas — ${(error as Error).message}`);
    return;
  }
  if (canvas.created) {
    new Notice(`Created a Canvas for “${paperLabel(paper)}” in Zotero.`);
    context.changed(refOf(paper));
  }
  const path = canvas.canvasPath;
  if (path && /\.canvas$/i.test(path)) {
    // openPath reports failure as a message rather than by rejecting.
    const failure = await shell.openPath(path);
    if (!failure) { return; }
    new Notice(`Could not open ${path}: ${failure}`);
    await openExternal(canvas.canvas);
    return;
  }

  const picked = await choose(context.app, {
    title: "Canvas file is missing",
    message:
      `The Canvas of “${paperLabel(paper)}” is in Zotero, but its file is not on this `
      + "machine.\n\nIf Zotero has not synced it down yet, show it in Zotero and let "
      + "sync finish. If the file was deleted, start a new empty Canvas; the old "
      + "entry goes to Zotero's trash.",
    choices: [
      { label: "Show in Zotero", value: "show" as const },
      { label: "New empty Canvas", value: "recreate" as const, warning: true },
    ],
  });
  if (picked === "show") {
    await openExternal(canvas.canvas);
  } else if (picked === "recreate") {
    if (await trash(context, paper, "canvas")) {
      await openCanvas(context, paper);
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

/**
 * Open the paper's Raw Markdown with the system's Markdown application — the same
 * thing as opening the attachment from Zotero.
 *
 * Without the file on this machine, and given a `context`, the user chooses between
 * waiting for sync (show it in Zotero), restoring it from Raw Backup, and
 * converting again. Without a context, the attachment is selected in Zotero.
 */
export async function openRaw(paper: BridgePaper, context?: ActionContext): Promise<void> {
  const path = paper.links.rawPath;
  if (path && /\.md$/i.test(path)) {
    // openPath reports failure as a message rather than by rejecting.
    const failure = await shell.openPath(path);
    if (!failure) { return; }
    new Notice(`Could not open ${path}: ${failure}`);
    if (paper.links.raw) { await openExternal(paper.links.raw); }
    return;
  }
  if (!paper.links.raw) {
    new Notice(
      `${paperLabel(paper)} has no Raw in Zotero yet. Use “Convert to Markdown”.`,
    );
    return;
  }
  if (!context) {
    await openExternal(paper.links.raw);
    return;
  }

  const backup = Boolean(paper.links.rawBackupPath);
  const picked = await choose(context.app, {
    title: "Raw file is missing",
    message:
      `The Raw of “${paperLabel(paper)}” is in Zotero, but its file is not on this `
      + "machine.\n\nIf Zotero has not synced it down yet, show it in Zotero and let "
      + "sync finish. If the file was deleted, "
      + (backup
        ? "restore it from Raw Backup (the latest conversion) or convert again."
        : "convert again.")
      + " The old entry goes to Zotero's trash.",
    choices: [
      { label: "Show in Zotero", value: "show" as const },
      ...(backup
        ? [{ label: "Restore from Raw Backup", value: "restore" as const, cta: true }]
        : []),
      { label: "Convert again", value: "convert" as const },
    ],
  });
  if (picked === "show") {
    await openExternal(paper.links.raw);
  } else if (picked === "restore") {
    await restoreRaw(context, paper, { confirmed: true });
  } else if (picked === "convert") {
    // The conversion itself replaces a Raw whose file is gone.
    await convertToMarkdown(
      context.bridge, refOf(paper), paper, context.defaultTemplate, { reconvert: true },
    );
  }
}

/**
 * Ask Zotero to run the paper-to-Markdown conversion for this item.
 *
 * The job runs in Zotero (UniZero panel); Obsidian only receives the acceptance
 * ack. After it finishes, open Raw from the menu.
 *
 * Cached papers are never refreshed on their own, so a menu can still offer
 * Convert after an earlier conversion finished. Unless `reconvert` is set, the
 * paper is read again first, and an existing Raw is opened instead of converting
 * twice. Re-converting never touches Raw; it replaces Raw Backup.
 */
export async function convertToMarkdown(
  bridge: UnizeroBridge,
  ref: PaperRef,
  paper?: BridgePaper,
  template?: string,
  options: { reconvert?: boolean } = {},
): Promise<void> {
  const label = paper?.title || `${ref.libraryID}/${ref.itemKey}`;
  if (!options.reconvert) {
    const current = await bridge.paper(ref).catch(() => undefined);
    if (current && hasRaw(current)) {
      await openRaw(current);
      return;
    }
  }
  try {
    const result = await bridge.convert(ref, template);
    new Notice(
      result.message
      || `Conversion started for “${label}”. Watch the UniZero panel in Zotero, then open Raw.`,
    );
  } catch (error) {
    new Notice(`UniZero: could not start conversion — ${(error as Error).message}`);
  }
}

/** Offer the runtime's templates in a menu at `event`, then convert with the pick. */
export async function chooseTemplateAndConvert(
  bridge: UnizeroBridge,
  ref: PaperRef,
  event: MouseEvent,
  defaultTemplate: string,
  paper?: BridgePaper,
  options: { reconvert?: boolean } = {},
): Promise<void> {
  const position = { x: event.clientX, y: event.clientY };
  let listed;
  try {
    listed = await bridge.templates();
  } catch (error) {
    new Notice(`UniZero: could not list templates — ${(error as Error).message}`);
    return;
  }
  const menu = new Menu();
  for (const entry of templateMenuEntries(listed, defaultTemplate)) {
    menu.addItem((item) => {
      item.setTitle(entry.title).setIcon(entry.disabled ? "info" : "file-down");
      if (entry.disabled) {
        item.setDisabled(true);
        return;
      }
      item.setChecked(entry.checked).onClick(() => {
        void convertToMarkdown(bridge, ref, paper, entry.template, options);
      });
    });
  }
  menu.showAtPosition(position);
}

/**
 * Move the paper's Raw or Canvas to Zotero's trash, asking first when `ask` is
 * set. Returns true once it is there; the next conversion, or the next Canvas
 * open, creates a new one.
 */
export async function trash(
  context: ActionContext,
  paper: PaperIdentity,
  kind: "raw" | "canvas",
  options: { ask?: boolean } = {},
): Promise<boolean> {
  const name = kind === "raw" ? "Raw" : "Canvas";
  if (options.ask && !(await confirm(context.app, {
    title: `Move ${name} to Zotero's trash?`,
    message:
      `The ${name} of “${paperLabel(paper)}” goes to Zotero's trash, where you can `
      + "restore it. "
      + (kind === "raw"
        ? "The next conversion creates a new Raw."
        : "The next Canvas click creates a new empty Canvas."),
    action: "Move to trash",
    warning: true,
  }))) {
    return false;
  }
  try {
    await context.bridge.trash(refOf(paper), kind);
  } catch (error) {
    new Notice(`UniZero: could not move the ${name} to the trash — ${(error as Error).message}`);
    return false;
  }
  new Notice(`Moved the ${name} of “${paperLabel(paper)}” to Zotero's trash.`);
  context.changed(refOf(paper));
  return true;
}

/**
 * Replace the paper's Raw with a copy of Raw Backup, the latest conversion, then
 * open it. An existing Raw goes to Zotero's trash; with one, the user is asked first.
 */
export async function restoreRaw(
  context: ActionContext,
  paper: PaperIdentity & { links?: { raw?: string } },
  options: { confirmed?: boolean; hasRaw?: boolean } = {},
): Promise<void> {
  const replacing = options.hasRaw ?? Boolean(paper.links?.raw);
  if (replacing && !options.confirmed && !(await confirm(context.app, {
    title: "Restore Raw from Raw Backup?",
    message:
      `The Raw of “${paperLabel(paper)}” is replaced by a copy of its Raw Backup, the `
      + "latest conversion. Your current Raw, with its edits, goes to Zotero's trash, "
      + "where you can restore it.",
    action: "Restore",
    warning: true,
  }))) {
    return;
  }
  let restored;
  try {
    restored = await context.bridge.restoreRaw(refOf(paper));
  } catch (error) {
    new Notice(`UniZero: could not restore Raw — ${(error as Error).message}`);
    return;
  }
  context.changed(refOf(paper));
  if (restored.rawPath) {
    const failure = await shell.openPath(restored.rawPath);
    if (!failure) { return; }
    new Notice(`Could not open ${restored.rawPath}: ${failure}`);
  }
  await openExternal(restored.raw);
}

/**
 * The Raw entries of a menu — the paper pane's right-click on Raw, and the
 * management part of citation and library menus. Re-convert runs the default
 * template; "Re-convert with template…" opens the template list as a second menu.
 */
export function addRawItems(
  menu: Menu,
  context: ActionContext,
  paper: PaperIdentity & { links?: BridgePaper["links"] },
  state: ArtifactState,
  event: MouseEvent,
): void {
  const ref = refOf(paper);
  const full = paper.links ? paper as BridgePaper : undefined;
  if (state.hasRaw) {
    menu.addItem((item) => item
      .setTitle("Re-convert (keeps Raw, updates Raw Backup)")
      .setIcon("refresh-cw")
      .onClick(() => {
        void convertToMarkdown(
          context.bridge, ref, full, context.defaultTemplate, { reconvert: true },
        );
      }));
    menu.addItem((item) => item
      .setTitle("Re-convert with template…")
      .setIcon("list")
      .onClick(() => {
        void chooseTemplateAndConvert(
          context.bridge, ref, event, context.defaultTemplate, full, { reconvert: true },
        );
      }));
  }
  if (state.hasRawBackup) {
    menu.addItem((item) => item
      .setTitle("Restore Raw from Raw Backup")
      .setIcon("history")
      .onClick(() => { void restoreRaw(context, paper, { hasRaw: state.hasRaw }); }));
  }
  if (state.hasRaw) {
    menu.addItem((item) => item
      .setTitle("Move Raw to Zotero trash")
      .setIcon("trash-2")
      .onClick(() => { void trash(context, paper, "raw", { ask: true }); }));
  }
}

/** The Canvas entries of a menu — the paper pane's right-click on Canvas, and others. */
export function addCanvasItems(
  menu: Menu,
  context: ActionContext,
  paper: PaperIdentity,
  state: ArtifactState,
): void {
  if (!state.hasCanvas) { return; }
  menu.addItem((item) => item
    .setTitle("Move Canvas to Zotero trash")
    .setIcon("trash-2")
    .onClick(() => { void trash(context, paper, "canvas", { ask: true }); }));
}

/** Raw and Canvas entries after a separator, for citation and library menus. */
export function addManageItems(
  menu: Menu,
  context: ActionContext,
  paper: PaperIdentity & { links?: BridgePaper["links"] },
  state: ArtifactState,
  event: MouseEvent,
): void {
  if (!state.hasRaw && !state.hasRawBackup && !state.hasCanvas) { return; }
  menu.addSeparator();
  addRawItems(menu, context, paper, state, event);
  addCanvasItems(menu, context, paper, state);
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
