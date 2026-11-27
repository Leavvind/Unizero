/**
 * Mentions of papers in Obsidian Vault notes, as the Obsidian plugin reports them
 * (docs/UNICONNECTION.md §3).
 *
 * Zotero cannot see a Vault, so the plugin, which already indexes it, sends a
 * snapshot of every `unizero://paper/…` link written in a Vault note through
 * `POST /vault-mentions`. Each snapshot replaces the previous one for its Vault.
 * Pure and derived: nothing here touches a Zotero item; the host keeps the
 * snapshots in a cache file that can be deleted and is rebuilt by the next push.
 * A Vault note is not a paper, so these mentions only ever count as Citations of
 * the paper they point at, never as anyone's References.
 */

import { PDF_ANCHOR, type PaperRef } from "@unizero/links";

/** One Vault note, as the plugin names it. The path is a label and an address for Obsidian only. */
export interface VaultNote {
  vaultID: string;
  vaultName: string;
  path: string;
  title: string;
  format: "md" | "canvas";
}

/** One evidence unit in a Vault note that mentions a paper. */
export interface VaultMention {
  note: VaultNote;
  cited: PaperRef;
  /** 0-based line in the Markdown, or in the Canvas card's text. */
  line: number;
  nodeId?: string;
  text: string;
  /** `zotero://open-pdf` links written in the same unit. */
  pdf: string[];
  /** Epoch ms the note last changed. */
  time?: number;
}

export interface VaultSnapshot {
  vaultID: string;
  vaultName: string;
  /** Epoch ms the plugin built the snapshot. */
  generatedAt: number;
  /** Epoch ms Zotero received it. */
  receivedAt: number;
  mentions: VaultMention[];
}

/** The Vault notes mentioning one paper, each with its mentions. */
export interface VaultNoteGroup {
  note: VaultNote;
  mentions: VaultMention[];
}

export const MAX_VAULT_MENTIONS = 50_000;
const MAX_TEXT = 2_000;
const MAX_LABEL = 1_024;
const MAX_PDF = 20;

export class VaultSnapshotError extends Error {}

/** `vault:<vaultID>:<path>`: a note's key beside papers' `libraryID:itemKey`. */
export function vaultNoteKey(note: Pick<VaultNote, "vaultID" | "path">): string {
  return `vault:${note.vaultID}:${note.path}`;
}

export function isVaultNoteKey(key: string): boolean {
  return key.startsWith("vault:");
}

function fail(message: string): never {
  throw new VaultSnapshotError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { fail(`${what} must be an object`); }
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max = MAX_LABEL, optional = false): string {
  if (value === undefined && optional) { return ""; }
  if (typeof value !== "string") { fail(`${what} must be a string`); }
  if (!optional && !value.trim()) { fail(`${what} must not be empty`); }
  if (value.length > max) { fail(`${what} is too long`); }
  return value;
}

function integer(value: unknown, what: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) { fail(`${what} must be an integer ≥ ${min}`); }
  return value;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Check a `POST /vault-mentions` body and turn it into a snapshot. Anything malformed
 * rejects the whole body: a half-read snapshot would silently drop mentions.
 * PDF links that are not exactly Zotero's `open-pdf` shape are left out.
 */
export function parseVaultSnapshot(body: unknown, receivedAt: number): VaultSnapshot {
  const payload = record(body, "body");
  const vaultID = text(payload.vaultID, "vaultID", 200);
  if (/[\u0000-\u001f\u007f/\\]/.test(vaultID)) { fail("vaultID is not a Vault identity"); }
  const vaultName = text(payload.vaultName, "vaultName");
  const generatedAt = time(payload.generatedAt) ?? receivedAt;
  if (!Array.isArray(payload.mentions)) { fail("mentions must be an array"); }
  if (payload.mentions.length > MAX_VAULT_MENTIONS) { fail(`more than ${MAX_VAULT_MENTIONS} mentions`); }
  const notes = new Map<string, VaultNote>();
  const mentions = payload.mentions.map((value, index): VaultMention => {
    const entry = record(value, `mentions[${index}]`);
    const libraryID = integer(entry.libraryID, `mentions[${index}].libraryID`, 1);
    const itemKey = text(entry.itemKey, `mentions[${index}].itemKey`, 64);
    if (!/^[A-Za-z0-9]+$/.test(itemKey)) { fail(`mentions[${index}].itemKey is not an item key`); }
    const path = text(entry.path, `mentions[${index}].path`);
    const format = entry.format === "canvas" ? "canvas" : entry.format === "md" ? "md" : fail(`mentions[${index}].format must be md or canvas`);
    const title = text(entry.title, `mentions[${index}].title`, MAX_LABEL, true) || path;
    // One object per note, so grouping and labels agree across its mentions.
    const key = vaultNoteKey({ vaultID, path });
    let note = notes.get(key);
    if (!note) {
      note = { vaultID, vaultName, path, title, format };
      notes.set(key, note);
    }
    const nodeId = entry.nodeId === undefined ? undefined : text(entry.nodeId, `mentions[${index}].nodeId`, 200);
    const pdf = Array.isArray(entry.pdf)
      ? entry.pdf.filter((url): url is string => typeof url === "string" && PDF_ANCHOR.test(url)).slice(0, MAX_PDF)
      : [];
    const mentionTime = time(entry.time);
    return {
      note,
      cited: { libraryID, itemKey },
      line: integer(entry.line, `mentions[${index}].line`),
      ...(nodeId !== undefined ? { nodeId } : {}),
      text: text(entry.text, `mentions[${index}].text`, MAX_TEXT, true),
      pdf,
      ...(mentionTime !== undefined ? { time: mentionTime } : {}),
    };
  });
  return { vaultID, vaultName, generatedAt, receivedAt, mentions };
}

/** Reading order within a note: Canvas card, then line. */
function compareInNote(left: VaultMention, right: VaultMention): number {
  return (left.nodeId || "").localeCompare(right.nodeId || "") || left.line - right.line;
}

export class VaultMentionIndex {
  private readonly vaults = new Map<string, VaultSnapshot>();

  /**
   * Replace the Vault's snapshot. An empty one forgets the Vault: the plugin sends it
   * when the Vault takes a new identity or stops sharing its notes, and a Vault with
   * no mentions has nothing to show.
   */
  public put(snapshot: VaultSnapshot): void {
    if (snapshot.mentions.length) { this.vaults.set(snapshot.vaultID, snapshot); } else { this.vaults.delete(snapshot.vaultID); }
  }

  public clear(): void {
    this.vaults.clear();
  }

  public snapshots(): VaultSnapshot[] {
    return [...this.vaults.values()].sort((left, right) => left.vaultName.localeCompare(right.vaultName));
  }

  public mentions(): VaultMention[] {
    return [...this.vaults.values()].flatMap((snapshot) => snapshot.mentions);
  }

  /** Vault notes mentioning `paper`, most mentions first. */
  public citations(paper: PaperRef): VaultNoteGroup[] {
    const grouped = new Map<string, VaultNoteGroup>();
    for (const mention of this.mentions()) {
      if (mention.cited.libraryID !== paper.libraryID || mention.cited.itemKey !== paper.itemKey) { continue; }
      const key = vaultNoteKey(mention.note);
      let group = grouped.get(key);
      if (!group) {
        group = { note: mention.note, mentions: [] };
        grouped.set(key, group);
      }
      group.mentions.push(mention);
    }
    const groups = [...grouped.values()];
    for (const group of groups) { group.mentions.sort(compareInNote); }
    return groups.sort((left, right) => right.mentions.length - left.mentions.length
      || left.note.title.localeCompare(right.note.title)
      || left.note.path.localeCompare(right.note.path));
  }

  /** The snapshots as stored on disk; `restore` reads them back. */
  public toJSON(): { version: 1; vaults: unknown[] } {
    return {
      version: 1,
      vaults: this.snapshots().map((snapshot) => ({
        vaultID: snapshot.vaultID,
        vaultName: snapshot.vaultName,
        generatedAt: snapshot.generatedAt,
        receivedAt: snapshot.receivedAt,
        mentions: snapshot.mentions.map((mention) => ({
          libraryID: mention.cited.libraryID,
          itemKey: mention.cited.itemKey,
          path: mention.note.path,
          title: mention.note.title,
          format: mention.note.format,
          line: mention.line,
          ...(mention.nodeId !== undefined ? { nodeId: mention.nodeId } : {}),
          text: mention.text,
          pdf: mention.pdf,
          ...(mention.time !== undefined ? { time: mention.time } : {}),
        })),
      })),
    };
  }

  /** Snapshots from the cache file; an unreadable Vault entry is skipped, not fatal. */
  public restore(stored: unknown): void {
    const vaults = (stored as { version?: unknown; vaults?: unknown })?.version === 1
      ? (stored as { vaults?: unknown }).vaults : undefined;
    if (!Array.isArray(vaults)) { return; }
    for (const entry of vaults) {
      try {
        const receivedAt = time((entry as { receivedAt?: unknown })?.receivedAt) ?? Date.now();
        this.put(parseVaultSnapshot(entry, receivedAt));
      } catch {
        // The next push from that Vault replaces it.
      }
    }
  }
}
