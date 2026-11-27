/**
 * Paper-to-paper relations derived from the links written in papers' Raw and Canvas
 * attachments (docs/UNICONNECTION.md §1–§3).
 *
 * Pure and memory-only: the host (src/zotero/paperLinkSources.ts) reads each file and
 * hands its scanned links here, keyed by the attachment. Nothing is written back to
 * an attachment, a note or a cache shard; dropping the index and reading the files
 * again rebuilds it. Only links that are paper-to-paper relations are kept — written
 * in paper A's Raw or Canvas and pointing at another paper B — and one evidence unit
 * (a paragraph, or one paragraph of a Canvas card) holds at most one mention of B.
 */

import {
  indexedLinks,
  isPaperToPaper,
  occurrenceSnippet,
  type DocumentLink,
  type PaperNotePurpose,
  type PaperRef,
} from "@unizero/links";

/** A paper's Raw or Canvas attachment. */
export interface PaperNote extends PaperRef {
  attachmentKey: string;
  purpose: PaperNotePurpose;
  /** The attachment's own title, for labels only. */
  title: string;
}

/** One mention of paper B in paper A's Raw or Canvas. */
export interface PaperMention {
  citing: PaperRef;
  cited: PaperRef;
  source: PaperNote;
  /** 0-based line in the Markdown, or in the Canvas card's text. */
  line: number;
  ch: number;
  /** The Canvas card holding the mention. */
  nodeId?: string;
  /** The unit's plain text; the line around the link when it sits outside a paragraph. */
  text: string;
  /** `zotero://open-pdf` links written in the same unit. */
  pdf: string[];
  /** Epoch ms the source file last changed. */
  time?: number;
}

/** The papers on the other end of a paper's mentions, each with every mention. */
export interface MentionGroup {
  paper: PaperRef;
  mentions: PaperMention[];
}

/** A source that could not be read; its previous mentions, if any, are kept. */
export interface SourceFailure {
  source: PaperNote;
  error: string;
}

interface SourceRecord {
  source: PaperNote;
  fingerprint?: string;
  time?: number;
  mentions: PaperMention[];
  error?: string;
}

export function scopedKey(paper: PaperRef): string {
  return `${paper.libraryID}:${paper.itemKey}`;
}

export function sourceKey(source: { libraryID: number; attachmentKey: string }): string {
  return `${source.libraryID}:${source.attachmentKey}`;
}

/** The paper-to-paper mentions among one document's links; render-only `nocite` links are none. */
export function mentionsOf(source: PaperNote, links: DocumentLink[], time?: number): PaperMention[] {
  const mentions: PaperMention[] = [];
  const seen = new Set<string>();
  const citing = { libraryID: source.libraryID, itemKey: source.itemKey };
  for (const link of indexedLinks(links)) {
    const target = link.target;
    if (target.kind !== "paper" || !isPaperToPaper({ kind: "zotero", ...citing, purpose: source.purpose }, target)) {
      continue;
    }
    const cited = { libraryID: target.libraryID, itemKey: target.itemKey };
    if (link.unit) {
      // Two links to B in one paragraph are one mention of B.
      const unit = `${scopedKey(cited)}|${link.nodeId ?? ""}|${link.unit.text}`;
      if (seen.has(unit)) { continue; }
      seen.add(unit);
    }
    mentions.push({
      citing, cited, source, line: link.line, ch: link.ch,
      ...(link.nodeId !== undefined ? { nodeId: link.nodeId } : {}),
      text: link.unit?.text || occurrenceSnippet(link.lineText, link.ch),
      pdf: link.unit ? [...link.unit.pdf] : [],
      ...(time !== undefined ? { time } : {}),
    });
  }
  return mentions;
}

export class PaperLinkIndex {
  private readonly records = new Map<string, SourceRecord>();

  /** The fingerprint the source was last read at; undefined before its first good read. */
  public fingerprint(source: { libraryID: number; attachmentKey: string }): string | undefined {
    return this.records.get(sourceKey(source))?.fingerprint;
  }

  /** Replace a source's mentions with those among `links`, read at `fingerprint`. */
  public put(source: PaperNote, fingerprint: string, links: DocumentLink[], time?: number): void {
    this.records.set(sourceKey(source), { source, fingerprint, time, mentions: mentionsOf(source, links, time) });
  }

  /**
   * A failed read never empties a source: a Canvas caught mid-save is invalid JSON
   * for a moment. Its last mentions stay, and the next refresh reads it again.
   */
  public fail(source: PaperNote, error: string): void {
    const known = this.records.get(sourceKey(source));
    this.records.set(sourceKey(source), {
      source,
      mentions: known?.mentions || [],
      time: known?.time,
      error,
    });
  }

  /** Forget every source not in `keys` (deleted, retagged, or its file gone). */
  public retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.records.keys()]) {
      if (!keys.has(key)) { this.records.delete(key); }
    }
  }

  public clear(): void {
    this.records.clear();
  }

  public get size(): number {
    return this.records.size;
  }

  public failures(): SourceFailure[] {
    return [...this.records.values()]
      .filter((record) => record.error)
      .map((record) => ({ source: record.source, error: record.error! }));
  }

  /** Every mention, in no particular order. */
  public mentions(): PaperMention[] {
    return [...this.records.values()].flatMap((record) => record.mentions);
  }

  /** Papers that `paper`'s own Raw or Canvas mentions. */
  public references(paper: PaperRef): MentionGroup[] {
    const key = scopedKey(paper);
    return groups(this.mentions().filter((mention) => scopedKey(mention.citing) === key), "cited");
  }

  /** Papers whose Raw or Canvas mentions `paper`. */
  public citations(paper: PaperRef): MentionGroup[] {
    const key = scopedKey(paper);
    return groups(this.mentions().filter((mention) => scopedKey(mention.cited) === key), "citing");
  }
}

/**
 * Most-mentioned first. Within a paper: Canvas before Raw, then by attachment, then
 * in reading order — the same order as the Obsidian Paper pane.
 */
export function compareMentions(left: PaperMention, right: PaperMention): number {
  const order = (mention: PaperMention) => mention.source.purpose === "canvas" ? 0 : 1;
  return order(left) - order(right)
    || left.source.attachmentKey.localeCompare(right.source.attachmentKey)
    || (left.nodeId || "").localeCompare(right.nodeId || "")
    || left.line - right.line
    || left.ch - right.ch;
}

function groups(mentions: PaperMention[], by: "cited" | "citing"): MentionGroup[] {
  const grouped = new Map<string, MentionGroup>();
  for (const mention of mentions) {
    const paper = mention[by], key = scopedKey(paper);
    let group = grouped.get(key);
    if (!group) {
      group = { paper, mentions: [] };
      grouped.set(key, group);
    }
    group.mentions.push(mention);
  }
  const result = [...grouped.values()];
  for (const group of result) { group.mentions.sort(compareMentions); }
  return result.sort((left, right) => right.mentions.length - left.mentions.length
    || scopedKey(left.paper).localeCompare(scopedKey(right.paper)));
}
