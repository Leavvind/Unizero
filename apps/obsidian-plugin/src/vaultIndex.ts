/**
 * Vault citation index.
 *
 * Tracks every UniZero paper link (item, Raw `.md`, `.pdf` with optional page)
 * across Markdown and Canvas files in the Obsidian vault. Provides fast lookups for
 * citation counts (used by LibraryView badges) and occurrence locations
 * with line/column coordinates and text context (used by DetailView Vault tab).
 */

import type { App, MarkdownView, TFile } from "obsidian";
import { paperRefKey, type CitationToken, type PaperRef } from "./citation";
import { scanDocumentLinks, scanCanvasLinks, type DocumentLink } from "./documentLinks";
import { LinkIndex, timeSlicer } from "./linkIndex";
import type { VaultIdentity } from "./vaultIdentity";

export interface VaultCitationOccurrence {
  file: TFile;
  filePath: string;
  /** 0-based line index in the source file or canvas node text. */
  line: number;
  /** 0-based column index of the start of the citation token. */
  ch: number;
  /** The full line text containing the citation. */
  lineText: string;
  token: CitationToken;
  /** Canvas node ID if the citation is inside an Obsidian Canvas card. */
  nodeId?: string;
}

export type VaultIndexListener = () => void;

/** Compatibility projection for the Library badges and existing consumers. */
function paperOccurrences(links: DocumentLink[], meta: { file?: TFile; filePath: string }): VaultCitationOccurrence[] {
  return links.flatMap((link) => link.target.kind !== "paper" ? [] : [{
    file: meta.file as TFile, filePath: meta.filePath, line: link.line, ch: link.ch, lineText: link.lineText,
    token: { libraryID: link.target.libraryID, itemKey: link.target.itemKey, action: link.target.action,
      ...(link.target.page ? { page: link.target.page } : {}), raw: link.raw, from: link.ch, to: link.ch + link.raw.length },
    ...(link.nodeId ? { nodeId: link.nodeId } : {}),
  }]);
}
export function scanTextCitations(text: string, meta: { file?: TFile; filePath: string }): VaultCitationOccurrence[] {
  return paperOccurrences(scanDocumentLinks(text), meta);
}
export function scanCanvasCitations(text: string, meta: { file?: TFile; filePath: string }): VaultCitationOccurrence[] {
  return paperOccurrences(scanCanvasLinks(text), meta);
}

/**
 * Whether a file is a Markdown or Canvas note inside the vault.
 *
 * Obsidian can also open a file from elsewhere on disk, such as a Canvas stored as
 * a Zotero attachment, and reports it with a machine-local path like
 * `file:C:/Users/...`. Vault paths never contain `:`, so such files are left out:
 * they are not notes in this vault, and their path means nothing on another machine.
 */
export function isIndexedNote(file: Pick<TFile, "path" | "extension">): boolean {
  return (file.extension === "md" || file.extension === "canvas") && !file.path.includes(":") && !/^[\\/]/.test(file.path);
}

function stampOf(file: TFile): string | undefined {
  return file.stat ? `${file.stat.mtime}:${file.stat.size}` : undefined;
}

/** What a subscriber renders from a file's occurrences, in order. */
function signature(occurrences: VaultCitationOccurrence[]): string {
  return occurrences
    .map((o) => `${o.nodeId ?? ""}\u0000${o.line}\u0000${o.ch}\u0000${o.token.raw}\u0000${o.lineText}`)
    .join("\u0001");
}

export class VaultIndex {
  /** Map of normalized file path -> list of occurrences in that file. */
  private readonly fileOccurrences = new Map<string, VaultCitationOccurrence[]>();

  /**
   * Map of `libraryID/itemKey` -> file path -> that file's occurrences of the paper.
   * Kept per file so one edit replaces one file's share instead of rebuilding all.
   */
  private readonly paperOccurrences = new Map<string, Map<string, VaultCitationOccurrence[]>>();

  private readonly listeners = new Set<VaultIndexListener>();

  private generation = 0;
  private readonly revisions = new Map<string, number>();
  private nextRevision = 0;
  private disposed = false;
  private readonly failedPaths = new Set<string>();
  /** The file state each path was last indexed at. */
  private readonly stamps = new Map<string, string>();

  readonly links = new LinkIndex();

  constructor(private readonly app: App, readonly identity?: VaultIdentity) {}

  /** Scan the vault's Markdown and Canvas files; `changedOnly` skips what is already current. */
  async initialize(options: { changedOnly?: boolean } = {}): Promise<void> {
    if (this.disposed) { return; }
    this.generation += 1;
    this.links.vaultState = "updating";
    this.links.notify();
    const known = new Set(this.app.vault.getFiles().filter(isIndexedNote).map((f) => f.path));
    for (const path of this.revisions.keys()) { if (!known.has(path)) { this.removeFile(path, false); } }
    const generation = this.generation;
    const files = this.app.vault.getFiles().filter(isIndexedNote);
    const slice = timeSlicer();
    for (const file of files) {
      const stamp = stampOf(file);
      if (options.changedOnly && stamp && this.stamps.get(file.path) === stamp) { continue; }
      await this.indexFile(file, false);
      await slice();
      if (generation !== this.generation || this.disposed) { return; }
    }
    if (generation === this.generation && !this.disposed) { this.links.vaultState = this.failedPaths.size ? "partial" : "complete"; this.links.notify(); this.notify(); }
  }

  /** Re-index a single modified/created file. */
  async indexFile(file: TFile, notify = true): Promise<void> {
    if (this.disposed) { return; }
    const path = file.path;
    const generation = this.generation;
    const revision = ++this.nextRevision;
    this.revisions.set(path, revision);
    try {
      const content = await this.app.vault.cachedRead(file);
      if (generation !== this.generation || revision !== this.revisions.get(path)
        || file.path !== path) { return; }
      this.indexFileContent(file, content, notify);
      this.failedPaths.delete(path);
      const stamp = stampOf(file);
      if (stamp) { this.stamps.set(path, stamp); }
    } catch (error) {
      if (generation === this.generation && revision === this.revisions.get(path) && !this.disposed) {
        this.failedPaths.add(path);
        this.stamps.delete(path);
        const record = this.links.records.get(`vault:${path}`);
        if (record) { this.links.stale(record.source, (error as Error).message, notify); }
        this.links.vaultState = "partial";
      }
      console.error(`UniZero: failed to index ${file.path}`, error);
    }
  }

  /** Update index for a renamed file. */
  async renameFile(oldPath: string, file: TFile): Promise<void> {
    this.removeFile(oldPath, false);
    if (isIndexedNote(file)) {
      await this.indexFile(file, false);
    }
    this.links.notify();
    this.notify();
  }

  /** Folder events may arrive without individual descendant events. */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    this.removeFolder(oldPath, false);
    const files = this.app.vault.getFiles().filter((file) =>
      file.path.startsWith(`${newPath}/`) && isIndexedNote(file));
    await Promise.all(files.map((file) => this.indexFile(file, false)));
    this.links.notify();
    this.notify();
  }

  removeFolder(path: string, notify = true): void {
    const prefix = `${path}/`;
    for (const filePath of new Set([...this.fileOccurrences.keys(), ...this.revisions.keys()])) {
      if (filePath.startsWith(prefix)) { this.removeFile(filePath, false); }
    }
    if (notify) { this.notify(); }
  }

  /** Remove a deleted file from the index. */
  removeFile(path: string, notify = true): void {
    this.failedPaths.delete(path);
    this.stamps.delete(path);
    this.identity?.remove(path);
    this.links.remove(`vault:${path}`);
    this.revisions.delete(path);
    const changed = this.replaceFile(path, []);
    if (changed && notify) { this.notify(); }
  }

  /** Index parsed content for a file and optionally notify subscribers. */
  indexFileContent(file: TFile, content: string, notify = true): void {
    if (this.disposed || !isIndexedNote(file)) { return; }
    if (file.extension === "md") { this.identity?.update(file.path, content); }
    const links = this.links.replace({ kind: "vault", path: file.path, title: file.basename || file.path,
      vaultID: this.identity?.settings().vaultID || "", uid: this.identity?.get(file.path)?.uid,
      format: file.extension as "md" | "canvas" }, content, undefined, notify);
    const occurrences = paperOccurrences(links, { file, filePath: file.path });
    const changed = this.replaceFile(file.path, occurrences);
    if (changed && notify) { this.notify(); }
  }

  /**
   * Swap one file's occurrences in both maps. Returns false when nothing a
   * subscriber shows has changed, so an edit away from any citation costs no
   * re-render.
   */
  private replaceFile(path: string, occurrences: VaultCitationOccurrence[]): boolean {
    const previous = this.fileOccurrences.get(path) || [];
    if (signature(previous) === signature(occurrences)) {
      // Same citations at the same places; keep the fresh TFile reference.
      if (occurrences.length) { this.fileOccurrences.set(path, occurrences); }
      return false;
    }

    for (const occurrence of previous) {
      const key = paperRefKey(occurrence.token);
      const byFile = this.paperOccurrences.get(key);
      byFile?.delete(path);
      if (byFile && !byFile.size) { this.paperOccurrences.delete(key); }
    }

    if (!occurrences.length) {
      this.fileOccurrences.delete(path);
      return true;
    }
    this.fileOccurrences.set(path, occurrences);
    for (const occurrence of occurrences) {
      const key = paperRefKey(occurrence.token);
      let byFile = this.paperOccurrences.get(key);
      if (!byFile) {
        byFile = new Map();
        this.paperOccurrences.set(key, byFile);
      }
      let list = byFile.get(path);
      if (!list) {
        list = [];
        byFile.set(path, list);
      }
      list.push(occurrence);
    }
    return true;
  }

  /** Get all occurrences of a paper in the vault. */
  getOccurrences(ref: PaperRef): VaultCitationOccurrence[] {
    const byFile = this.paperOccurrences.get(paperRefKey(ref));
    return byFile ? [...byFile.values()].flat() : [];
  }

  /** Get total number of citations of a paper in the vault. */
  getCount(ref: PaperRef): number {
    let count = 0;
    for (const list of this.paperOccurrences.get(paperRefKey(ref))?.values() || []) {
      count += list.length;
    }
    return count;
  }

  /** Subscribe to index changes. */
  subscribe(listener: VaultIndexListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("UniZero: vaultIndex listener failed", error);
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.revisions.clear();
    this.failedPaths.clear();
    this.stamps.clear();
    this.fileOccurrences.clear();
    this.paperOccurrences.clear();
    this.identity?.clear();
    for (const [key, record] of this.links.records) { if (record.source.kind === "vault") { this.links.records.delete(key); } }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.listeners.clear();
    this.links.dispose();
  }

  /**
   * Jump to a citation occurrence in Obsidian editor or Canvas.
   */
  async openOccurrence(occurrence: VaultCitationOccurrence): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(occurrence.file);

    // Canvas navigation if applicable
    if (occurrence.file.extension === "canvas" && occurrence.nodeId) {
      try {
        const view = leaf.view as unknown as {
          canvas?: {
            nodes?: Map<string, unknown> | { get: (id: string) => unknown };
            selectOnly?: (node: unknown) => void;
            zoomToSelection?: () => void;
            panToNode?: (node: unknown) => void;
          };
        };
        if (view && view.canvas) {
          const canvas = view.canvas;
          const node = canvas.nodes instanceof Map
            ? canvas.nodes.get(occurrence.nodeId)
            : (canvas.nodes as { get: (id: string) => unknown })?.get?.(occurrence.nodeId);
          if (node) {
            canvas.selectOnly?.(node);
            canvas.zoomToSelection?.();
          }
        }
      } catch (error) {
        console.debug("UniZero: canvas navigation fallback", error);
      }
      return;
    }

    // Markdown editor navigation
    const view = leaf.view as unknown as { editor?: MarkdownView["editor"] };
    if (view && view.editor) {
      const editor = view.editor;
      const ch = occurrence.ch;
      const line = occurrence.line;
      const tokenLength = occurrence.token.raw.length;
      editor.setCursor({ line, ch });
      editor.scrollIntoView(
        {
          from: { line, ch },
          to: { line, ch: ch + tokenLength },
        },
        true,
      );
      editor.focus();
    }
  }
}
