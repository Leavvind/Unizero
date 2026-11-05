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
    const error = await shell.openPath(source.path!);
    if (error) { throw new Error(error); }
    if (same?.nodeId) { new Notice("UniZero: opened the original Canvas; select card " + same.nodeId + "."); }
  } else {
    await openExternalMarkdown(plugin, source.path!, undefined, same?.line);
  }
}
