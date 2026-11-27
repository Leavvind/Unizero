import { describe, expect, it } from "vitest";
import type { LinkOccurrence, SourceDocument } from "../src/linkIndex";
import type { LinkTarget } from "../src/linkTarget";
import type { NativeOutgoingLink } from "../src/nativeLinks";
import { groupOutgoingMentions, mentionTargets, outgoingGroups, presentTerms, type NoteResolution } from "../src/outgoingLinks";
import { findMentions } from "../src/unlinkedMentions";

const source: SourceDocument = { kind: "vault", path: "a.md", title: "a", vaultID: "V", format: "md" };
const occurrence = (target: LinkTarget, line: number, ch = 0): LinkOccurrence =>
  ({ target, raw: "[x](unizero://…)", from: 0, to: 0, line, ch, lineText: "", source, stale: false });
const paper = (itemKey: string, extra: Partial<Extract<LinkTarget, { kind: "paper" }>> = {}): LinkTarget =>
  ({ kind: "paper", libraryID: 1, itemKey, action: "detail", ...extra });
const note = (uid: string, vaultID = "V"): LinkTarget => ({ kind: "note", vaultID, uid });
const notes: Record<string, NoteResolution> = {
  "1": { status: "found", notes: [{ path: "notes/One.md" }] },
  dup: { status: "conflict", notes: [{ path: "x.md" }, { path: "y.md" }] },
};
const resolve = (vaultID: string, uid: string): NoteResolution =>
  vaultID !== "V" ? { status: "other-vault", notes: [] } : notes[uid] || { status: "missing", notes: [] };
const native = (link: Partial<NativeOutgoingLink> & { linkpath: string }): NativeOutgoingLink =>
  ({ form: "wikilink", raw: `[[${link.linkpath}]]`, ...link });

describe("outgoingGroups", () => {
  it("groups each paper once, whatever its action or page", () => {
    const groups = outgoingGroups([occurrence(paper("A"), 4), occurrence(paper("A", { action: "pdf", page: 3 }), 1), occurrence(paper("B"), 2)], [], resolve);
    expect(groups.map((g) => [g.section, g.key, g.rows.length])).toEqual([["paper", "paper:1/A", 2], ["paper", "paper:1/B", 1]]);
    expect(groups[0].rows.map((r) => r.kind === "unizero" && r.occurrence.line)).toEqual([1, 4]);
  });

  it("merges UniZero and native links to the same Vault note", () => {
    const groups = outgoingGroups([occurrence(note("1"), 5)], [native({ linkpath: "One", targetPath: "notes/One.md", line: 2, ch: 0 })], resolve);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ section: "note", path: "notes/One.md", label: "One" });
    expect(groups[0].rows.map((r) => r.kind)).toEqual(["native", "unizero"]);
  });

  it("explains UniZero notes that do not resolve, and keeps unresolved native links", () => {
    const groups = outgoingGroups([occurrence(note("dup"), 0), occurrence(note("gone"), 1), occurrence(note("1", "W"), 2)],
      [native({ linkpath: "Later", line: 3, ch: 0 })], resolve);
    expect(groups.map((g) => [g.section, g.label, g.problem])).toEqual([
      ["unresolved", "UID dup", "UID conflict: x.md, y.md"],
      ["unresolved", "UID gone", "No note has this UID"],
      ["unresolved", "UID 1", "In Vault W"],
      ["unresolved", "Later", "Not created yet"],
    ]);
  });

  it("orders groups by where their first link appears, properties on top", () => {
    const groups = outgoingGroups([occurrence(paper("A"), 9)], [native({ linkpath: "P", form: "property", targetPath: "P.md" }),
      native({ linkpath: "Q", targetPath: "Q.md", line: 3, ch: 7 }), native({ linkpath: "R", targetPath: "R.md", line: 3, ch: 2 })], resolve);
    expect(groups.map((g) => g.label)).toEqual(["P", "R", "Q", "1/A"]);
  });
});

describe("outgoing unlinked mentions", () => {
  const candidates = [
    { path: "a.md", basename: "a", aliases: [] },
    { path: "Graph theory.md", basename: "Graph theory", aliases: ["graphs"] },
    { path: "old/Graph theory.md", basename: "Graph theory", aliases: [] },
    { path: "Linked.md", basename: "Linked", aliases: [] },
    { path: "图论.md", basename: "图论", aliases: [] },
  ];

  it("maps titles and aliases to every note that answers to them, leaving out the note and its links", () => {
    const targets = mentionTargets(candidates, "a.md", new Set(["Linked.md"]));
    expect(Object.fromEntries(targets)).toEqual({ "graph theory": ["Graph theory.md", "old/Graph theory.md"], graphs: ["Graph theory.md"], "图论": ["图论.md"] });
  });

  it("lists each mention under every note it may name", () => {
    const targets = mentionTargets(candidates, "a.md", new Set());
    const text = "Notes on graph Theory and 图论的应用.\nSee [[Linked]] and Graphs.";
    const terms = presentTerms(text, targets);
    expect(terms.sort()).toEqual(["graph theory", "graphs", "linked", "图论"]);
    const grouped = groupOutgoingMentions(findMentions(text, terms), targets);
    expect(grouped.map((g) => [g.path, g.mentions.map((m) => m.text)])).toEqual([
      ["Graph theory.md", ["graph Theory", "Graphs"]],
      ["old/Graph theory.md", ["graph Theory"]],
      ["图论.md", ["图论"]],
    ]);
  });
});
