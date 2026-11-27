/**
 * A paper's References and Citations derived from written links (docs/UNICONNECTION.md §1).
 *
 * Both lists hold two groups. **Papers**: a link written in a paper's Raw or Canvas —
 * a Zotero document whose `purpose` says so — that points at another paper. **Notes**:
 * every other indexed link — in References, the paper's Raw / Canvas links to Vault
 * notes; in Citations, links into the paper from Vault notes, other Markdown
 * attachments and the paper's own notes. Render-only `nocite` links never reach the
 * index. Several links in one evidence unit to the same paper or note are one mention,
 * as in Zotero (docs/UNICONNECTION.md §2). Nothing here is stored: it is recomputed from the shared link index, which
 * owns no bibliographic state.
 */

import { isPaperNotePurpose, isPaperToPaper as linkIsPaperToPaper, pdfAnchorPage, unitKey } from "@unizero/links";
import type { PaperRef } from "./citation";
import { sourceIdentity, type LinkIndex, type LinkOccurrence, type SourceDocument } from "./linkIndex";
import { targetIdentity, type LinkTarget } from "./linkTarget";

export { pdfAnchorPage };

export type PaperNoteSource = SourceDocument & { kind: "zotero"; purpose: "raw" | "canvas" };

export interface RelatedPaper {
  paper: PaperRef;
  /** The owning paper's title as the link index knows it; Citations only. */
  title?: string;
  mentions: LinkOccurrence[];
}

export function isPaperNote(source: SourceDocument): source is PaperNoteSource {
  return source.kind === "zotero" && isPaperNotePurpose(source.purpose);
}

const keyOf = (paper: PaperRef): string => `${paper.libraryID}/${paper.itemKey}`;

/** Adds `occurrence` to the group under `key` unless that group already has a link from its unit. */
function mention(seen: Set<string>, key: string, mentions: LinkOccurrence[], occurrence: LinkOccurrence): void {
  const unit = `${key}|${sourceIdentity(occurrence.source)}|${unitKey(occurrence)}`;
  if (seen.has(unit)) { return; }
  seen.add(unit);
  mentions.push(occurrence);
}

/**
 * Notes on either side of a paper's links: in References one Vault note the paper's
 * Raw / Canvas links to (`target`), in Citations one document that links into the
 * paper (`source`, the first mention's).
 */
export interface RelatedNote {
  key: string;
  title: string;
  /** References only: the linked Vault note, without heading or block. */
  target?: Extract<LinkTarget, { kind: "note" }>;
  mentions: LinkOccurrence[];
}

/** A relation between two distinct papers, the link written in the first one's Raw or Canvas. */
export function isPaperToPaper(occurrence: LinkOccurrence): boolean {
  return linkIsPaperToPaper(occurrence.source, occurrence.target);
}

/** Papers whose Raw or Canvas links to `paper`, with every such link. */
export function paperCitations(index: LinkIndex, paper: PaperRef): RelatedPaper[] {
  const groups = new Map<string, RelatedPaper>(), seen = new Set<string>();
  for (const occurrence of index.query({ kind: "paper", ...paper, action: "detail" })) {
    if (!isPaperToPaper(occurrence)) { continue; }
    const source = occurrence.source as PaperNoteSource;
    const from = { libraryID: source.libraryID, itemKey: source.itemKey }, key = keyOf(from);
    let group = groups.get(key);
    if (!group) { group = { paper: from, title: source.itemTitle, mentions: [] }; groups.set(key, group); }
    mention(seen, key, group.mentions, occurrence);
  }
  return sortGroups([...groups.values()]);
}

/** Papers that `paper`'s own Raw or Canvas links to, with every such link. */
export function paperReferences(index: LinkIndex, paper: PaperRef): RelatedPaper[] {
  const groups = new Map<string, RelatedPaper>(), seen = new Set<string>();
  for (const record of index.recordsOfPaper(paper)) {
    for (const occurrence of record.links) {
      if (!isPaperToPaper(occurrence) || occurrence.target.kind !== "paper") { continue; }
      const to = { libraryID: occurrence.target.libraryID, itemKey: occurrence.target.itemKey }, key = keyOf(to);
      let group = groups.get(key);
      if (!group) { group = { paper: to, mentions: [] }; groups.set(key, group); }
      mention(seen, key, group.mentions, occurrence);
    }
  }
  return sortGroups([...groups.values()]);
}

/** Vault notes that `paper`'s own Raw or Canvas links to, with every such link. */
export function noteReferences(index: LinkIndex, paper: PaperRef): RelatedNote[] {
  const groups = new Map<string, RelatedNote>(), seen = new Set<string>();
  for (const record of index.recordsOfPaper(paper)) {
    if (!isPaperNote(record.source)) { continue; }
    for (const occurrence of record.links) {
      const target = occurrence.target;
      if (target.kind !== "note") { continue; }
      const key = targetIdentity(target);
      let group = groups.get(key);
      if (!group) {
        group = { key, title: target.uid, target: { kind: "note", vaultID: target.vaultID, uid: target.uid }, mentions: [] };
        groups.set(key, group);
      }
      mention(seen, key, group.mentions, occurrence);
    }
  }
  return sortGroups([...groups.values()]);
}

/**
 * Documents that link into `paper` without a paper-to-paper relation: Vault notes,
 * other Markdown attachments, and the paper's own Raw / Canvas linking to itself.
 */
export function noteCitations(index: LinkIndex, paper: PaperRef): RelatedNote[] {
  const groups = new Map<string, RelatedNote>(), seen = new Set<string>();
  for (const occurrence of index.query({ kind: "paper", ...paper, action: "detail" })) {
    if (isPaperToPaper(occurrence)) { continue; }
    const source = occurrence.source, key = sourceIdentity(source);
    let group = groups.get(key);
    if (!group) { group = { key, title: sourceTitle(source), mentions: [] }; groups.set(key, group); }
    mention(seen, key, group.mentions, occurrence);
  }
  return sortGroups([...groups.values()]);
}

/** A Zotero document is named with its paper, since attachment titles repeat across papers. */
function sourceTitle(source: SourceDocument): string {
  return source.kind === "vault" ? source.title : [source.itemTitle, source.title].filter(Boolean).join(" · ");
}

/** Most-mentioned first; within a group, Canvas before Raw, then in reading order. */
function sortGroups<T extends { title?: string; mentions: LinkOccurrence[] } & ({ paper: PaperRef } | { key: string })>(groups: T[]): T[] {
  const keyOf = (group: T) => "paper" in group ? `${group.paper.libraryID}/${group.paper.itemKey}` : group.key;
  const order = (o: LinkOccurrence) => o.source.kind === "zotero" && o.source.purpose === "canvas" ? 0 : 1;
  for (const group of groups) {
    group.mentions.sort((a, b) => order(a) - order(b)
      || (a.source.kind === "zotero" && b.source.kind === "zotero" ? a.source.attachmentKey.localeCompare(b.source.attachmentKey) : 0)
      || a.line - b.line || a.ch - b.ch);
  }
  return groups.sort((a, b) => b.mentions.length - a.mentions.length
    || (a.title || "").localeCompare(b.title || "") || keyOf(a).localeCompare(keyOf(b)));
}
