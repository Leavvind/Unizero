/**
 * Vault citation index.
 *
 * Tracks every paper citation (`@libraryID/itemKey`, `.md`, `.pdf`, `.pdf:{page}`)
 * across Markdown and Canvas files in the Obsidian vault. Provides fast lookups for
 * citation counts (used by LibraryView badges) and occurrence locations
 * with line/column coordinates and text context (used by DetailView Vault tab).
 */

import type { App, MarkdownView, TFile } from "obsidian";
import { paperRefKey, scanCitations, type CitationToken, type PaperRef } from "./citation";

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

/**
 * Helper to extract citations from plain text / markdown.
 */
export function scanTextCitations(
  text: string,
  fileMeta: { file?: TFile; filePath: string },
): VaultCitationOccurrence[] {
  const occurrences: VaultCitationOccurrence[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineText = lines[lineIndex];
    if (!lineText.includes("@")) { continue; }
    const tokens = scanCitations(lineText);
    for (const token of tokens) {
      occurrences.push({
        file: fileMeta.file as TFile,
        filePath: fileMeta.filePath,
        line: lineIndex,
        ch: token.from,
        lineText,
        token,
      });
    }
  }
  return occurrences;
}

/**
 * Helper to extract citations from Obsidian Canvas JSON files.
 */
export function scanCanvasCitations(
  jsonContent: string,
  fileMeta: { file?: TFile; filePath: string },
): VaultCitationOccurrence[] {
  const occurrences: VaultCitationOccurrence[] = [];
  try {
    const data = JSON.parse(jsonContent);
    if (data && Array.isArray(data.nodes)) {
      for (const node of data.nodes) {
        if (!node) { continue; }
        const nodeId = typeof node.id === "string" ? node.id : undefined;
        if (node.type === "text" && typeof node.text === "string") {
          const textOccurrences = scanTextCitations(node.text, fileMeta);
          for (const occ of textOccurrences) {
            occurrences.push({
              ...occ,
              nodeId,
            });
          }
        } else if (node.type === "group" && typeof node.label === "string") {
          const labelOccurrences = scanTextCitations(node.label, fileMeta);
          for (const occ of labelOccurrences) {
            occurrences.push({
              ...occ,
              nodeId,
            });
          }
        }
      }
    }
  } catch (error) {
    // If JSON parse fails, fall back to scanning raw text
    return scanTextCitations(jsonContent, fileMeta);
  }
  return occurrences;
}

export class VaultIndex {
  /** Map of normalized file path -> list of occurrences in that file. */
  private readonly fileOccurrences = new Map<string, VaultCitationOccurrence[]>();

  /** Map of `libraryID/itemKey` -> list of occurrences. */
  private readonly paperOccurrences = new Map<string, VaultCitationOccurrence[]>();

  private readonly listeners = new Set<VaultIndexListener>();

  private generation = 0;
  private readonly revisions = new Map<string, number>();
  private nextRevision = 0;
  private disposed = false;

  constructor(private readonly app: App) {}

  /** Scan all Markdown and Canvas files in the vault. */
  async initialize(): Promise<void> {
    if (this.disposed) { return; }
    this.clear();
    const generation = this.generation;
    const files = this.app.vault.getFiles().filter(
      (file) => file.extension === "md" || file.extension === "canvas",
    );
    await Promise.all(
      files.map((file) => this.indexFile(file, false)),
    );
    if (generation === this.generation) { this.notify(); }
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
    } catch (error) {
      console.error(`UniZero: failed to index ${file.path}`, error);
    }
  }

  /** Update index for a renamed file. */
  async renameFile(oldPath: string, file: TFile): Promise<void> {
    this.removeFile(oldPath, false);
    if (file.extension === "md" || file.extension === "canvas") {
      await this.indexFile(file, false);
    }
    this.notify();
  }

  /** Folder events may arrive without individual descendant events. */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    this.removeFolder(oldPath, false);
    const files = this.app.vault.getFiles().filter((file) =>
      file.path.startsWith(`${newPath}/`)
      && (file.extension === "md" || file.extension === "canvas"));
    await Promise.all(files.map((file) => this.indexFile(file, false)));
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
    this.revisions.delete(path);
    const previous = this.fileOccurrences.get(path);
    if (!previous || previous.length === 0) {
      this.fileOccurrences.delete(path);
      return;
    }

    this.fileOccurrences.delete(path);
    this.rebuildPaperIndex();
    if (notify) {
      this.notify();
    }
  }

  /** Index parsed content for a file and optionally notify subscribers. */
  indexFileContent(file: TFile, content: string, notify = true): void {
    const occurrences = file.extension === "canvas"
      ? scanCanvasCitations(content, { file, filePath: file.path })
      : scanTextCitations(content, { file, filePath: file.path });

    if (occurrences.length === 0) {
      const hadPrevious = this.fileOccurrences.has(file.path);
      this.fileOccurrences.delete(file.path);
      if (hadPrevious) {
        this.rebuildPaperIndex();
        if (notify) { this.notify(); }
      }
      return;
    }

    this.fileOccurrences.set(file.path, occurrences);
    this.rebuildPaperIndex();
    if (notify) {
      this.notify();
    }
  }

  /** Reconstruct the paper -> occurrences mapping from fileOccurrences. */
  private rebuildPaperIndex(): void {
    this.paperOccurrences.clear();
    for (const occurrences of this.fileOccurrences.values()) {
      for (const occurrence of occurrences) {
        const key = paperRefKey(occurrence.token);
        let list = this.paperOccurrences.get(key);
        if (!list) {
          list = [];
          this.paperOccurrences.set(key, list);
        }
        list.push(occurrence);
      }
    }
  }

  /** Get all occurrences of a paper in the vault. */
  getOccurrences(ref: PaperRef): VaultCitationOccurrence[] {
    const key = paperRefKey(ref);
    return this.paperOccurrences.get(key) || [];
  }

  /** Get total number of citations of a paper in the vault. */
  getCount(ref: PaperRef): number {
    return this.getOccurrences(ref).length;
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
    this.fileOccurrences.clear();
    this.paperOccurrences.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.listeners.clear();
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
