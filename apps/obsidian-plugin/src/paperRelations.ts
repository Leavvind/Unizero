/**
 * Paper-to-paper relations derived from written links (docs/UNICONNECTION_REDESIGN.md §3).
 *
 * A link is a paper-to-paper relation only when it is written in a paper's Raw or
 * Canvas — a Zotero document whose `purpose` says so — and points at another paper.
 * Everything else (Vault notes, other Markdown attachments, a paper's links to
 * itself) is an ordinary link. Nothing here is stored: it is recomputed from the
 * shared link index, which owns no bibliographic state.
 */

import type { PaperRef } from "./citation";
import type { LinkIndex, LinkOccurrence, SourceDocument } from "./linkIndex";

export type PaperNoteSource = SourceDocument & { kind: "zotero"; purpose: "raw" | "canvas" };

export interface RelatedPaper {
  paper: PaperRef;
  /** The owning paper's title as the link index knows it; Citations only. */
  title?: string;
  mentions: LinkOccurrence[];
}

export function isPaperNote(source: SourceDocument): source is PaperNoteSource {
  return source.kind === "zotero" && (source.purpose === "raw" || source.purpose === "canvas");
}

const samePaper = (a: PaperRef, b: PaperRef): boolean => a.libraryID === b.libraryID && a.itemKey === b.itemKey;
const keyOf = (paper: PaperRef): string => `${paper.libraryID}/${paper.itemKey}`;

/** A relation between two distinct papers, the link written in the first one's Raw or Canvas. */
export function isPaperToPaper(occurrence: LinkOccurrence): boolean {
  return isPaperNote(occurrence.source) && occurrence.target.kind === "paper"
    && !samePaper(occurrence.source, occurrence.target);
}

/** Papers whose Raw or Canvas links to `paper`, with every such link. */
export function paperCitations(index: LinkIndex, paper: PaperRef): RelatedPaper[] {
  const groups = new Map<string, RelatedPaper>();
  for (const occurrence of index.query({ kind: "paper", ...paper, action: "detail" })) {
    if (!isPaperToPaper(occurrence)) { continue; }
    const source = occurrence.source as PaperNoteSource;
    const from = { libraryID: source.libraryID, itemKey: source.itemKey }, key = keyOf(from);
    let group = groups.get(key);
    if (!group) { group = { paper: from, title: source.itemTitle, mentions: [] }; groups.set(key, group); }
    group.mentions.push(occurrence);
  }
  return sortGroups([...groups.values()]);
}

/** Papers that `paper`'s own Raw or Canvas links to, with every such link. */
export function paperReferences(index: LinkIndex, paper: PaperRef): RelatedPaper[] {
  const groups = new Map<string, RelatedPaper>();
  for (const record of index.recordsOfPaper(paper)) {
    for (const occurrence of record.links) {
      if (!isPaperToPaper(occurrence) || occurrence.target.kind !== "paper") { continue; }
      const to = { libraryID: occurrence.target.libraryID, itemKey: occurrence.target.itemKey }, key = keyOf(to);
      let group = groups.get(key);
      if (!group) { group = { paper: to, mentions: [] }; groups.set(key, group); }
      group.mentions.push(occurrence);
    }
  }
  return sortGroups([...groups.values()]);
}

/** Links into `paper` that are not paper-to-paper relations. */
export function paperLinks(index: LinkIndex, paper: PaperRef): LinkOccurrence[] {
  return index.query({ kind: "paper", ...paper, action: "detail" }).filter((occurrence) => !isPaperToPaper(occurrence));
}

/** Most-mentioned first; within a paper, Canvas before Raw, then in reading order. */
function sortGroups(groups: RelatedPaper[]): RelatedPaper[] {
  const order = (o: LinkOccurrence) => o.source.kind === "zotero" && o.source.purpose === "canvas" ? 0 : 1;
  for (const group of groups) {
    group.mentions.sort((a, b) => order(a) - order(b)
      || (a.source.kind === "zotero" && b.source.kind === "zotero" ? a.source.attachmentKey.localeCompare(b.source.attachmentKey) : 0)
      || a.line - b.line || a.ch - b.ch);
  }
  return groups.sort((a, b) => b.mentions.length - a.mentions.length
    || (a.title || "").localeCompare(b.title || "") || keyOf(a.paper).localeCompare(keyOf(b.paper)));
}

/** Page of a Zotero PDF link, for labels only. */
export function pdfAnchorPage(url: string): number | undefined {
  const page = /[?&]page=(\d+)/.exec(url)?.[1];
  return page ? Number(page) : undefined;
}
