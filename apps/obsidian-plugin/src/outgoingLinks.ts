/**
 * What one document links to, for the Outgoing links pane: its UniZero links (read
 * from the link index record of the document itself) and, for a Vault note, its
 * native Obsidian links, grouped by destination. Host-free; the view supplies UID
 * resolution and renders the groups.
 */
import type { LinkOccurrence } from "./linkIndex";
import type { NativeOutgoingLink } from "./nativeLinks";
import type { Mention } from "./unlinkedMentions";

export type OutgoingRow = { kind: "unizero"; occurrence: LinkOccurrence } | { kind: "native"; link: NativeOutgoingLink };
export type OutgoingSection = "paper" | "note" | "unresolved";
export interface OutgoingGroup {
  key: string;
  section: OutgoingSection;
  /** A paper destination. */
  paper?: { libraryID: number; itemKey: string };
  /** A resolved Vault file. */
  path?: string;
  /** What to call the destination when nothing better is known. */
  label: string;
  /** Why an unresolved destination did not resolve. */
  problem?: string;
  rows: OutgoingRow[];
}
export interface NoteResolution { status: "found" | "missing" | "conflict" | "other-vault"; notes: Array<{ path: string }> }

const rowLine = (row: OutgoingRow) => row.kind === "native" ? row.link.line ?? -1 : row.occurrence.line;
const rowCh = (row: OutgoingRow) => row.kind === "native" ? row.link.ch ?? -1 : row.occurrence.ch;
const basename = (path: string) => path.split("/").pop()!.replace(/\.(md|canvas)$/, "");

/**
 * Groups by destination: a paper, a resolved Vault file (UniZero and native links to
 * the same note share one group), or an unresolved destination. Groups follow the
 * order their first link appears in the document; property links count as the top.
 */
export function outgoingGroups(occurrences: readonly LinkOccurrence[], native: readonly NativeOutgoingLink[],
  resolveNote: (vaultID: string, uid: string) => NoteResolution): OutgoingGroup[] {
  const groups = new Map<string, OutgoingGroup>();
  const add = (key: string, make: () => Omit<OutgoingGroup, "key" | "rows">, row: OutgoingRow) => {
    let group = groups.get(key);
    if (!group) { group = { key, ...make(), rows: [] }; groups.set(key, group); }
    group.rows.push(row);
  };
  for (const occurrence of occurrences) {
    const target = occurrence.target, row = { kind: "unizero" as const, occurrence };
    if (target.kind === "paper") {
      const paper = { libraryID: target.libraryID, itemKey: target.itemKey };
      add(`paper:${paper.libraryID}/${paper.itemKey}`, () => ({ section: "paper", paper, label: `${paper.libraryID}/${paper.itemKey}` }), row);
      continue;
    }
    const resolution = resolveNote(target.vaultID, target.uid);
    if (resolution.status === "found") {
      const path = resolution.notes[0].path;
      add(`file:${path}`, () => ({ section: "note", path, label: basename(path) }), row);
      continue;
    }
    const problem = resolution.status === "conflict" ? `UID conflict: ${resolution.notes.map((n) => n.path).join(", ")}`
      : resolution.status === "other-vault" ? `In Vault ${target.vaultID}` : "No note has this UID";
    add(`uid:${JSON.stringify([target.vaultID, target.uid])}`, () => ({ section: "unresolved", label: `UID ${target.uid}`, problem }), row);
  }
  for (const link of native) {
    const row = { kind: "native" as const, link };
    if (link.targetPath) {
      const path = link.targetPath;
      add(`file:${path}`, () => ({ section: "note", path, label: basename(path) }), row);
    } else {
      add(`unresolved:${link.linkpath}`, () => ({ section: "unresolved", label: link.linkpath, problem: "Not created yet" }), row);
    }
  }
  const first = new Map<OutgoingGroup, [number, number]>();
  for (const group of groups.values()) {
    group.rows.sort((a, b) => rowLine(a) - rowLine(b) || rowCh(a) - rowCh(b));
    first.set(group, [rowLine(group.rows[0]), rowCh(group.rows[0])]);
  }
  return [...groups.values()].sort((a, b) => {
    const [la, ca] = first.get(a)!, [lb, cb] = first.get(b)!;
    return la - lb || ca - cb;
  });
}

export interface MentionCandidate { path: string; basename: string; aliases: readonly string[] }
const termKey = (term: string) => term.trim().toLowerCase();

/**
 * The terms an outgoing unlinked mention may use: each other note's title and
 * aliases, mapped to every note that answers to it. Notes the document already
 * links to, and the document itself, are left out.
 */
export function mentionTargets(candidates: readonly MentionCandidate[], sourcePath: string, linked: ReadonlySet<string>): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.path === sourcePath || linked.has(candidate.path)) { continue; }
    for (const term of new Set([candidate.basename, ...candidate.aliases].map(termKey).filter(Boolean))) {
      const paths = targets.get(term) || [];
      paths.push(candidate.path);
      targets.set(term, paths);
    }
  }
  return targets;
}

/**
 * The terms that occur in `text` at all, as written in `targets`. A Vault has far
 * more titles than one note uses, so this cheap pass keeps the mention pattern small.
 */
export function presentTerms(text: string, targets: ReadonlyMap<string, unknown>): string[] {
  const lower = text.toLowerCase();
  return [...targets.keys()].filter((term) => lower.includes(term));
}

/**
 * Mentions found in the document, under each note they may name, ordered by path.
 * A term two notes share lists the mention under both; linking picks one explicitly.
 */
export function groupOutgoingMentions(mentions: readonly Mention[], targets: ReadonlyMap<string, readonly string[]>): Array<{ path: string; mentions: Mention[] }> {
  const byPath = new Map<string, Mention[]>();
  for (const mention of mentions) {
    for (const path of targets.get(termKey(mention.text)) || []) {
      const list = byPath.get(path) || [];
      list.push(mention);
      byPath.set(path, list);
    }
  }
  return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, list]) => ({ path, mentions: list }));
}
