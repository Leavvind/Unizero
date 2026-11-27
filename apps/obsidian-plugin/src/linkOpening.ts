import { Notice, TFile } from "obsidian";
import { shell } from "electron";
import { readFile } from "fs/promises";
import type UnizeroPlugin from "./main";
import { BRIDGE_API } from "./bridge";
import { withPdfPage } from "./citation";
import { normalizeLocalPath } from "./externalIndex";
import type { LinkTarget, TextLocation } from "./linkTarget";
import { resolveTextLocation, scanCanvasLinks, scanDocumentLinks } from "./documentLinks";
import type { LinkOccurrence } from "./linkIndex";
import type { NativeBacklink } from "./nativeLinks";

/** Open an attachment in Obsidian's own editor, which addresses outside files as `file:<path>`. */
async function openExternalMarkdown(plugin: UnizeroPlugin, path: string, location?: TextLocation, line?: number): Promise<void> {
  const resolved = resolveTextLocation(location ? await readFile(path, "utf8") : "", location);
  const targetLine = resolved.line ?? line;
  const file = plugin.app.vault.getAbstractFileByPath(`file:${normalizeLocalPath(path)}`);
  if (file instanceof TFile) {
    await plugin.app.workspace.getLeaf("tab").openFile(file, targetLine === undefined ? undefined : { eState: { line: targetLine } });
  } else {
    // Obsidian versions without outside files: the system handler cannot take a position.
    const error = await shell.openPath(path);
    if (error) { throw new Error(error); }
    if (targetLine !== undefined) { new Notice(`UniZero: opened the file; go to line ${targetLine + 1}.`); }
  }
  if (resolved.status === "missing" || resolved.status === "ambiguous") {
    new Notice(`UniZero: opened the file; the original ${location!.kind} is ${resolved.status}.`);
  }
}

/**
 * Open a Zotero Canvas in Obsidian, which addresses outside files as `file:<path>`, and
 * select the card `nodeId` once the Canvas has loaded. Without outside files the system
 * handler opens it, and the card has to be found by hand.
 */
async function openExternalCanvas(plugin: UnizeroPlugin, path: string, nodeId?: string): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(`file:${normalizeLocalPath(path)}`);
  if (file instanceof TFile) {
    await plugin.vaultIndex.openOccurrence({ file, filePath: file.path, line: 0, ch: 0, lineText: "",
      ...(nodeId ? { nodeId } : {}),
      token: { libraryID: 1, itemKey: "SOURCE", action: "detail", raw: "", from: 0, to: 0 } });
    return;
  }
  const error = await shell.openPath(path);
  if (error) { throw new Error(error); }
  if (nodeId) { new Notice(`UniZero: opened the original Canvas; select card ${nodeId}.`); }
}

const ZOTERO_KEY = /^[A-Za-z0-9]+$/;

/**
 * `obsidian://unizero?libraryID=…&itemKey=…&canvas=…&node=…`, from Zotero's Uniconnection:
 * a paper's Zotero Canvas at the card holding a mention. The URL names the Canvas only by
 * its Zotero identity; its file comes from the bridge's artifact list, which answers
 * only for a Canvas still attached to that paper.
 */
export async function openZoteroCanvas(plugin: UnizeroPlugin, params: Record<string, string | undefined>): Promise<void> {
  const libraryID = Number(params.libraryID), itemKey = params.itemKey || "", key = params.canvas || "";
  if (!/^[1-9]\d*$/.test(params.libraryID || "") || !Number.isSafeInteger(libraryID)
    || !ZOTERO_KEY.test(itemKey) || !ZOTERO_KEY.test(key)) {
    throw new Error("Invalid Canvas link from Zotero.");
  }
  const files = await plugin.bridge.artifacts({ libraryID, itemKey });
  const canvas = files.artifacts.find((artifact) => artifact.kind === "canvas" && artifact.key === key);
  if (!canvas) { throw new Error("That Canvas is no longer attached to the paper in Zotero."); }
  if (!canvas.path) { throw new Error("That Canvas's file is not on this computer; let Zotero sync finish."); }
  await openExternalCanvas(plugin, canvas.path, params.node || undefined);
}

export async function openLinkTarget(plugin: UnizeroPlugin, target: LinkTarget): Promise<void> {
  if (target.kind === "paper") {
    if (target.action === "detail") { await plugin.showInDetailView(target); return; }
    const ping = await plugin.bridge.ping();
    if (ping.api !== BRIDGE_API || !ping.capabilities.includes("link-targets")) { throw new Error("Update the Zotero add-on to resolve document links."); }
    const resolved = await plugin.bridge.linkTarget(target, target.action, target.attachmentKey);
    if (target.action === "pdf") {
      if (!resolved.url) { throw new Error("The requested PDF is unavailable."); }
      await shell.openExternal(withPdfPage(resolved.url, target.page)); return;
    }
    if (!resolved.source?.path) { throw new Error("The requested attachment is missing or has not synced."); }
    await openExternalMarkdown(plugin, resolved.source.path, target.location);
    return;
  }
  const result = plugin.identity.resolve(target.vaultID, target.uid);
  if (result.status === "other-vault") { throw new Error(`Open the registered Vault ${target.vaultID} to follow this link.`); }
  if (result.status === "conflict") { throw new Error(`UID conflict: ${result.notes.map((n) => n.path).join(", ")}. Repair the duplicate UID first.`); }
  if (result.status === "missing") { throw new Error(`No document with UID ${target.uid}; it may be missing or not synced.`); }
  const file = plugin.app.vault.getAbstractFileByPath(result.notes[0].path);
  if (!(file instanceof TFile)) { throw new Error("The document is unavailable."); }
  const text = await plugin.app.vault.read(file);
  const location = resolveTextLocation(text, target.location);
  const leaf = plugin.app.workspace.getLeaf(false);
  await leaf.openFile(file, location.line === undefined ? undefined : { eState: { line: location.line } });
  if (location.status === "missing" || location.status === "ambiguous") {
    new Notice(`UniZero: opened the file; the original ${target.location!.kind} is ${location.status}.`);
  }
}

export async function openLinkOccurrence(plugin: UnizeroPlugin, occurrence: LinkOccurrence): Promise<void> {
  const source = occurrence.source;
  const text = source.kind === "vault" ? await plugin.app.vault.adapter.read(source.path)
    : source.path ? await readFile(source.path, "utf8") : undefined;
  if (text === undefined) { throw new Error("The source file is unavailable on this machine."); }
  const links = source.format === "canvas" ? scanCanvasLinks(text) : scanDocumentLinks(text);
  const same = links.find((l) => l.line === occurrence.line && l.ch === occurrence.ch && l.nodeId === occurrence.nodeId && l.raw === occurrence.raw);
  if (!same) { new Notice("UniZero: opened the source file; the original link position is no longer available."); }
  if (source.kind === "vault") {
    const file = plugin.app.vault.getAbstractFileByPath(source.path);
    if (!(file instanceof TFile)) { throw new Error("The source document is missing."); }
    if (source.format === "canvas" && same) {
      await plugin.vaultIndex.openOccurrence({ file, filePath: file.path, line: same.line, ch: same.ch,
        lineText: same.lineText, nodeId: same.nodeId,
        token: { libraryID: 1, itemKey: "SOURCE", action: "detail", raw: same.raw, from: same.ch, to: same.ch + same.raw.length } });
    } else { await plugin.app.workspace.getLeaf(false).openFile(file, same ? { eState: { line: same.line } } : undefined); }
  } else if (source.format === "canvas") {
    await openExternalCanvas(plugin, source.path!, same?.nodeId);
  } else {
    await openExternalMarkdown(plugin, source.path!, undefined, same?.line);
  }
}

/** Opens the Vault note holding a native link or mention, at its line when one is known. */
export async function openNativeBacklink(plugin: UnizeroPlugin, link: Pick<NativeBacklink, "sourcePath" | "line">): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(link.sourcePath);
  if (!(file instanceof TFile)) { throw new Error("The source document is missing."); }
  await plugin.app.workspace.getLeaf(false).openFile(file, link.line === undefined ? undefined : { eState: { line: link.line } });
}

/**
 * `obsidian://unizero?vault=…&vaultID=…&file=…&line=…&node=…`, from Zotero's Uniconnection:
 * the Vault note holding a mention, at its line or Canvas card. `file` is a path in
 * this Vault (not `path`, which Obsidian reserves for absolute filesystem paths); anything else is refused rather than guessed at.
 */
export async function openVaultLocation(plugin: UnizeroPlugin, params: Record<string, string | undefined>): Promise<void> {
  if (params.vaultID && params.vaultID !== plugin.settings.vaultID) {
    throw new Error("That note belongs to another Vault; open it there.");
  }
  const file = plugin.app.vault.getAbstractFileByPath(params.file || "");
  if (!(file instanceof TFile) || !["md", "canvas"].includes(file.extension)) {
    throw new Error("That note is not in this Vault any more; it may have moved since Zotero last heard from Obsidian.");
  }
  const line = /^\d+$/.test(params.line || "") ? Number(params.line) : undefined;
  if (file.extension === "canvas") {
    await plugin.vaultIndex.openOccurrence({ file, filePath: file.path, line: line ?? 0, ch: 0, lineText: "",
      ...(params.node ? { nodeId: params.node } : {}),
      token: { libraryID: 1, itemKey: "SOURCE", action: "detail", raw: "", from: 0, to: 0 } });
    return;
  }
  await plugin.app.workspace.getLeaf(false).openFile(file, line === undefined ? undefined : { eState: { line } });
}
