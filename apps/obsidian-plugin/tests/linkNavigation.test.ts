import { describe, expect, it } from "vitest";
import { scanDocumentLinks } from "../src/documentLinks";
import { parseLinkTarget, parseLinkTargetForNavigation } from "../src/linkTarget";

const paper = "unizero://paper/1/E23A232D.md";
const target = { kind: "paper", libraryID: 1, itemKey: "E23A232D", action: "markdown" };

describe("navigation from unfinished or malformed locations", () => {
  it.each(["^", "#", "#^", "#%5E", "#%ZZ", "#^bad_id", "＃", "＾", "……"])
    ("opens the same file for %s", (suffix) => {
      expect(parseLinkTargetForNavigation(paper + suffix)).toEqual(target);
      expect(parseLinkTarget(paper + suffix)).toBeUndefined();
    });

  it.each(["^1231312", "＾1231312", "……1231312", "＃^1231312"])
    ("resolves completed block shorthand %s", (suffix) => {
      expect(parseLinkTargetForNavigation(paper + suffix)).toEqual({ ...target, location: { kind: "block", value: "1231312" } });
    });

  it("keeps the library and explicit attachment when dropping a location", () => {
    expect(parseLinkTargetForNavigation("unizero://paper/7/E23A232D.md?attachment=RAW2#^"))
      .toEqual({ ...target, libraryID: 7, attachmentKey: "RAW2" });
    expect(parseLinkTargetForNavigation(paper + "?attachment=RAW2^1231312"))
      .toEqual({ ...target, attachmentKey: "RAW2", location: { kind: "block", value: "1231312" } });
  });

  it("recovers an incomplete Vault location without changing its UID", () => {
    expect(parseLinkTargetForNavigation("unizero://note/my%20vault/00123#^"))
      .toEqual({ kind: "note", vaultID: "my vault", uid: "00123" });
  });

  it.each([
    "unizero://paper/0/E23A232D.md^", "unizero://paper/9007199254740992/E23A232D.md^",
    `${paper}?attachment=^`, `${paper}?attachment=RAW1&attachment=RAW2#^`, `${paper}?page=2#^`,
    `${paper}?unknown=1#^`, "unizero://note/v/..#^", "unizero://note/v/%2Fid#^",
    "unizero://paper/1/E23A232D.pdf^", "https://example.com/file.md^",
  ])("does not repair an invalid identity or attachment: %s", (uri) => {
    expect(parseLinkTargetForNavigation(uri)).toBeUndefined();
  });

  it("leaves valid encoded fragments unchanged, decoding only once", () => {
    for (const uri of [paper + "#%5E1231312", paper + "#literal%2523heading", paper + "#%E6%A0%87%E9%A2%98", paper + "#＾1231312"]) {
      expect(parseLinkTargetForNavigation(uri)).toEqual(parseLinkTarget(uri));
    }
  });

  it("makes inline and reference links navigable while keeping indexing strict", () => {
    const text = `[北岛 & 林道群, 2022](${paper}^) [reference][ref]\n\n[ref]: ${paper}#%5E`;
    expect(scanDocumentLinks(text)).toEqual([]);
    expect(scanDocumentLinks(text, parseLinkTargetForNavigation).map((link) => link.target)).toEqual([target, target]);
    expect(scanDocumentLinks(`\`[code](${paper}^)\`\n%%[hidden](${paper}^)%%`, parseLinkTargetForNavigation)).toEqual([]);
  });
});
