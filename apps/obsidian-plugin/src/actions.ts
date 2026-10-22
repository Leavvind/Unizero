/**
 * What each citation form does when clicked.
 *
 * `@libraryID/itemKey` stays inside Obsidian; `.md` opens the paper's Raw Markdown;
 * `.pdf` / `.pdf:{page}` hand off to Zotero (optional physical page via `?page=`).
 * The plugin may request two side-effects: conversion posts to the bridge's
 * convert action, which runs the same Zotero menu command, and the first Canvas
 * open asks Zotero to add an empty Canvas attachment. Neither edits bibliographic
 * fields from Obsidian.
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

import { Menu, Notice } from "obsidian";
import { shell } from "electron";
import type { BridgeCanvas, BridgePaper, UnizeroBridge } from "./bridge";
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
 * Open the paper's Canvas note — the hand-made note surface for this paper.
 *
 * Zotero answers with the paper's Canvas attachment, creating an empty one on the
 * first open, so a stale cached paper never offers a second Canvas. The file opens
 * with the system's handler for `.canvas`, as it does from Zotero; without the file
 * on this machine (not yet synced down, say), the attachment is selected in Zotero.
 */
export async function openCanvas(
  bridge: UnizeroBridge,
  paper: PaperIdentity,
): Promise<void> {
  let canvas: BridgeCanvas;
  try {
    canvas = await bridge.canvas(paper);
  } catch (error) {
    new Notice(`UniZero: could not open the Canvas — ${(error as Error).message}`);
    return;
  }
  if (canvas.created) {
    new Notice(`Created a Canvas for “${paperLabel(paper)}” in Zotero.`);
  }
  const path = canvas.canvasPath;
  if (path && /\.canvas$/i.test(path)) {
    // openPath reports failure as a message rather than by rejecting.
    const failure = await shell.openPath(path);
    if (!failure) { return; }
    new Notice(`Could not open ${path}: ${failure}`);
  }
  await openExternal(canvas.canvas);
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
  template?: string,
): Promise<void> {
  const label = paper?.title || `${ref.libraryID}/${ref.itemKey}`;
  const current = await bridge.paper(ref).catch(() => undefined);
  if (current && hasRaw(current)) {
    await openRaw(current);
    return;
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
        void convertToMarkdown(bridge, ref, paper, entry.template);
      });
    });
  }
  menu.showAtPosition(position);
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
