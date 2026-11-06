import { describe, expect, it } from "vitest";
import { parseLinkTarget, serializeLinkTarget, markdownLink, paperLabel, type LinkTarget } from "../src/linkTarget";
import { scanDocumentLinks, scanCanvasLinks, resolveTextLocation, textAnchors, occurrenceSnippet, retargetInlineLink } from "../src/documentLinks";
import { readDocumentUID, VaultIdentity } from "../src/vaultIdentity";

const ref = { libraryID: 2, itemKey: "ABCD1234" };
const L = "[a](unizero://paper/2/ABCD1234)";

describe("occurrenceSnippet", () => {
  it("shows the label without the destination or block markup", () => {
    const line = "## See [丁学良, 2017](unizero://paper/1/KEY.md#%E6%B6%B5) and [x](https://e.com) too";
    expect(occurrenceSnippet(line, line.indexOf("["))).toBe("See 丁学良, 2017 and x too");
  });
  it("keeps a late link in view", () => {
    const line = `${"long ".repeat(100)}[Label](unizero://paper/1/KEY) ${"tail ".repeat(100)}`;
    const snippet = occurrenceSnippet(line, line.indexOf("["));
    expect(snippet).toContain("Label");
    expect(snippet.startsWith("…") && snippet.endsWith("…")).toBe(true);
  });
});
const settings = { vaultID: "vault-a", uidSource: "property" as const, uidProperty: "uid", uidFilenamePattern: "" };

describe("durable URI boundary", () => {
  it("round-trips text locations without double decoding", () => {
    for (const value of ["Methods [one] 100% #标题", "literal%23heading", "a/b?c#d", "标题"]) {
      const target: LinkTarget = { kind: "paper", ...ref, action: "markdown", attachmentKey: "RAW12345", location: { kind: "heading", value } };
      expect(parseLinkTarget(serializeLinkTarget(target))).toEqual(target);
    }
    const target: LinkTarget = { kind: "note", vaultID: "my vault", uid: "000123", location: { kind: "block", value: "result-01" } };
    expect(serializeLinkTarget(target)).toContain("#%5Eresult-01");
    expect(parseLinkTarget(serializeLinkTarget(target))).toEqual(target);
  });
  it.each([
    "unizero://v2/paper/2/ABCD1234", "unizero://paper/0/KEY", "unizero://paper/1/KEY.pdf?page=0",
    "unizero://paper/1/KEY.pdf?page=01", "unizero://paper/1/KEY.pdf?page=1&page=2",
    "unizero://paper/1/KEY.md?page=2", "unizero://paper/1/KEY#Heading", "unizero://paper/1/KEY.pdf#Heading",
    "unizero://paper/1/KEY?attachment=RAW", "unizero://paper/1/KEY.md?attachment=",
    "unizero://note/a/id?attachment=x", "unizero://note/a/%2Fid", "unizero://note/a/..",
    "unizero://paper/1/KEY.pdf.15", "unizero://paper/1/KEY.md#%ZZ", "unizero://paper/1/KEY.md#%5E",
    "unizero://paper/1/KEY.pdf?page=9007199254740992", "unizero://note/a/id?version=2",
  ])("rejects unsupported or ambiguous targets: %s", (uri) => { expect(parseLinkTarget(uri)).toBeUndefined(); });
  it("escapes the label and preserves normal Markdown structure", () => {
    const link = markdownLink("[A] *manual* \\ label", { kind: "paper", ...ref, action: "detail" });
    expect(scanDocumentLinks(link)).toHaveLength(1);
    expect(paperLabel({ ...ref, authors: ["A Smith", "B Jones", "C Doe"], year: "2024" })).toBe("Smith et al., 2024");
    expect(paperLabel({ ...ref, title: "No author" })).toBe("No author");
  });
});

describe("structural source parsing", () => {
  it("retargets edited labels without losing Markdown or brackets in code", () => {
    const target: LinkTarget = { kind: "note", vaultID: "a", uid: "123" };
    expect(retargetInlineLink('[**edited** `]`](unizero://paper/2/ABCD1234)', target)).toBe('[**edited** `]`](unizero://note/a/123)');
  });
  it.each([
    ["a line starting with a wikilink", "[[Note]] see "],
    ["a short wikilink", "[[a]] "],
    ["a list item starting with a wikilink", "- [[Note]] "],
    ["a line starting with a comment", "%%todo%% "],
    ["a list item starting with a comment", "- %%todo%% "],
    ["two comments", "%%a%% %%b%% "],
    ["the last line of a multi-line comment", "%%a\nb%% "],
  ])("keeps links after %s", (_name, prefix) => {
    const text = prefix + L;
    const links = scanDocumentLinks(text);
    expect(links).toHaveLength(1);
    expect(text.slice(links[0].from, links[0].to)).toBe(L);
  });
  it("keeps Obsidian syntax out of the scan and out of the block structure", () => {
    expect(scanDocumentLinks(`before %% ${L} %% after`)).toHaveLength(0);
    expect(scanDocumentLinks(`%%\n${L}\n%%`)).toHaveLength(0);
    expect(scanDocumentLinks(`    [[Note]] ${L}`)).toHaveLength(0);
    expect(scanDocumentLinks(`\`[[Note]]\` ${L}`)).toHaveLength(1);
    expect(scanDocumentLinks(`%%comment%%\n\n    ${L}`)).toHaveLength(0);
  });
  it("finds anchors on lines with wikilinks and comments", () => {
    expect(resolveTextLocation("[[Note]] text ^abc\n", { kind: "block", value: "abc" }).status).toBe("found");
    expect(resolveTextLocation("%%c%% text ^abc\n", { kind: "block", value: "abc" }).status).toBe("found");
    expect(resolveTextLocation("text ^abc %%c%%\n", { kind: "block", value: "abc" }).status).toBe("found");
    expect(resolveTextLocation("%%text ^abc%%\n", { kind: "block", value: "abc" }).status).toBe("missing");
    // A block ID on its own line closing a paragraph belongs to that line, not the one before.
    expect(resolveTextLocation("intro\n\nParagraph text\n^abc\n", { kind: "block", value: "abc" })).toEqual({ status: "found", line: 3 });
    expect(textAnchors("# [[Note]] intro\n")[0].location.value).toBe("[[Note]] intro");
    expect(textAnchors("# %%c%% intro\n")[0].location.value).toBe("intro");
    expect(textAnchors("[[Note]]\n---\n")[0].location.value).toBe("[[Note]]");
  });
  it("reports correct positions in documents with many lines", () => {
    const text = ["first", "", `second ${L} here`, "", "third [b](unizero://paper/2/ABCD1234.md)", "last line"].join("\r\n");
    expect(scanDocumentLinks(text).map((l) => [l.line, l.ch, l.lineText])).toEqual([
      [2, 7, `second ${L} here`], [4, 6, "third [b](unizero://paper/2/ABCD1234.md)"],
    ]);
  });
  it("does not let comment delimiters inside code hide later links", () => {
    expect(scanDocumentLinks(`\`%%\`\n\n${L}`)).toHaveLength(1);
    expect(scanDocumentLinks(`\`\`\`\n%%\n\`\`\`\n\n${L}`)).toHaveLength(1);
  });
  it("counts inline and reference links once, excluding inert regions and bare tokens", () => {
    const text = ["---", "uid: '@2/ABCD1234'", "---", "[my @2/ABCD1234](unizero://paper/2/ABCD1234)",
      "[ref][paper] @2/ABCD1234.pdf:15", "", "[paper]: unizero://paper/2/ABCD1234.md#Methods", "",
      `\`${L}\``, "", `    ${L}`, `<!-- ${L} -->`, `%% ${L} %%`,
      "[ordinary @2/ABCD1234](https://example.com)", "```md", L, "```"].join("\n");
    const links = scanDocumentLinks(text);
    expect(links).toHaveLength(2);
    for (const link of links) { expect(text.slice(link.from, link.to)).toBe(link.raw); }
  });
  it("ignores arbitrary Canvas properties and file embeds, keeps text, group and edge labels", () => {
    const json = JSON.stringify({ nodes: [{ id: "t", type: "text", text: L },
      { id: "f", type: "file", file: "@2/ABCD1234.md" }, { id: "g", type: "group", label: L }],
      edges: [{ id: "e", label: "[note](unizero://note/a/123)" }], other: L });
    expect(scanCanvasLinks(json).map((l) => l.nodeId)).toEqual(["t", "g", "e"]);
    expect(() => scanCanvasLinks("{broken")).toThrow();
  });
  it("retains file identity when a location is missing or duplicated", () => {
    const text = "# Methods\n\nnew contents ^result-01\n\n# Methods\n";
    expect(resolveTextLocation(text, { kind: "heading", value: "Methods" }).status).toBe("ambiguous");
    expect(resolveTextLocation(text, { kind: "block", value: "result-01" })).toEqual({ status: "found", line: 2 });
    expect(resolveTextLocation(text, { kind: "block", value: "gone" }).status).toBe("missing");
    expect(resolveTextLocation(text).status).toBe("file");
  });
});

describe("Vault UID mapping", () => {
  it("preserves opaque strings and safe numeric UIDs, rejects lossy numbers", () => {
    expect(readDocumentUID('---\nuid: "00123"\n---\n', "x.md", settings).uid).toBe("00123");
    expect(readDocumentUID("---\nuid: 20260728102240\n---\n", "x.md", settings).uid).toBe("20260728102240");
    for (const value of ["00123", "9007199254740993", "1e20", "[a, b]"]) {
      expect(readDocumentUID(`---\nuid: ${value}\n---\n`, "x.md", settings).error).toBeTruthy();
    }
  });
  it("rebuilds after rename, detects copy conflicts and keeps Vault scope", () => {
    const identity = new VaultIdentity(() => settings);
    identity.update("a.md", "---\nuid: abc\n---\n");
    identity.remove("a.md"); identity.update("Archive/b.md", "---\nuid: abc\n---\n");
    expect(identity.resolve("vault-a", "abc").notes[0].path).toBe("Archive/b.md");
    identity.update("copy.md", "---\nuid: abc\n---\n");
    expect(identity.resolve("vault-a", "abc").status).toBe("conflict");
    expect(identity.resolve("vault-b", "abc").status).toBe("other-vault");
    identity.update("no-uid.md", "# note"); expect(identity.get("no-uid.md")?.uid).toBeUndefined();
  });
  it("reads filename UIDs only with an explicit configured capture", () => {
    expect(readDocumentUID("", "20260728102240 title.md", settings).uid).toBeUndefined();
    expect(readDocumentUID("", "20260728102240 title.md", { ...settings, uidSource: "filename", uidFilenamePattern: "^(\\d{14}) " }).uid).toBe("20260728102240");
  });
});
