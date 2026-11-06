import { describe, expect, it } from "vitest";
import type { CachedMetadata, ReferenceCache } from "obsidian";
import { nativeBacklinks, type NativeLinkHost } from "../src/nativeLinks";

const ref = (original: string, link: string, line: number, col = 0): ReferenceCache => ({
  original, link, position: { start: { line, col, offset: 0 }, end: { line, col: col + original.length, offset: 0 } },
});
const names: Record<string, string> = { Target: "Target.md", Other: "Other.md", "folder/Target": "folder/Target.md" };

function host(caches: Record<string, Partial<CachedMetadata>>, texts: Record<string, string>,
  resolved: Record<string, Record<string, number>>): NativeLinkHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    resolvedLinks: resolved,
    fileCache: (path) => caches[path],
    resolve: (linkpath) => names[linkpath.replace(/\.md$/, "")],
    read: async (path) => { reads.push(path); return texts[path]; },
  };
}

describe("nativeBacklinks", () => {
  it("lists wikilinks, embeds and Markdown links into the target with their lines", async () => {
    const h = host({
      "a.md": {
        links: [ref("[[Target]]", "Target", 2, 4), ref("[[Other]]", "Other", 3), ref("[x](Target.md)", "Target.md", 0)],
        embeds: [ref("![[Target#Methods]]", "Target#Methods", 5)],
      },
    }, { "a.md": "[x](Target.md)\n\nSee [[Target]] here\n[[Other]]\n\n![[Target#Methods]]" }, { "a.md": { "Target.md": 3, "Other.md": 1 } });
    const links = await nativeBacklinks(h, "Target.md");
    expect(links.map((l) => [l.form, l.line, l.ch, l.subpath])).toEqual([
      ["markdown", 0, 0, undefined], ["wikilink", 2, 4, undefined], ["embed", 5, 0, "Methods"],
    ]);
    expect(links[1].lineText).toBe("See [[Target]] here");
  });

  it("lists property links without a position", async () => {
    const h = host({ "p.md": { frontmatterLinks: [{ key: "related", link: "Target", original: "[[Target]]" }] } }, {},
      { "p.md": { "Target.md": 1 } });
    expect(await nativeBacklinks(h, "Target.md")).toEqual([
      { sourcePath: "p.md", form: "property", raw: "[[Target]]", subpath: undefined, key: "related" },
    ]);
    expect(h.reads).toEqual([]);
  });

  it("keeps a source whose links Obsidian counted but the cache cannot place", async () => {
    const h = host({}, {}, { "board.canvas": { "Target.md": 2 } });
    expect(await nativeBacklinks(h, "Target.md")).toEqual([{ sourcePath: "board.canvas", form: "file", count: 2 }]);
  });

  it("skips self-links, sources that do not point here, and same-named notes elsewhere", async () => {
    const h = host({
      "Target.md": { links: [ref("[[#Intro]]", "#Intro", 1), ref("[[Target]]", "Target", 2)] },
      "b.md": { links: [ref("[[folder/Target]]", "folder/Target", 0)] },
    }, {}, { "Target.md": { "Target.md": 2 }, "b.md": { "folder/Target.md": 1 }, "c.md": { "Target.md": 0 } });
    expect(await nativeBacklinks(h, "Target.md")).toEqual([]);
  });

  it("orders sources by path", async () => {
    const h = host({ "z.md": { links: [ref("[[Target]]", "Target", 0)] }, "a.md": { links: [ref("[[Target]]", "Target", 0)] } },
      { "z.md": "[[Target]]", "a.md": "[[Target]]" }, { "z.md": { "Target.md": 1 }, "a.md": { "Target.md": 1 } });
    expect((await nativeBacklinks(h, "Target.md")).map((l) => l.sourcePath)).toEqual(["a.md", "z.md"]);
  });
});
