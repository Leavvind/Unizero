import { describe, expect, it } from "vitest";
import { isIndexedNote, scanCanvasCitations, scanTextCitations } from "../src/vaultIndex";

describe("scanTextCitations", () => {
  it("extracts citations from multi-line text with line numbers and character offsets", () => {
    const text = `# Title

In this section we reference [a](unizero://paper/1/ITEM123) and also [a](unizero://paper/1/ITEM456.md).

Some other line with no citations.
A line with PDF citation: [a](unizero://paper/2/PDF999.pdf?page=42) at page 42.
`;

    const occurrences = scanTextCitations(text, { filePath: "Notes/test.md" });

    expect(occurrences).toHaveLength(3);

    expect(occurrences[0]).toEqual({
      file: undefined,
      filePath: "Notes/test.md",
      line: 2,
      ch: 29,
      lineText: "In this section we reference [a](unizero://paper/1/ITEM123) and also [a](unizero://paper/1/ITEM456.md).",
      token: {
        raw: "[a](unizero://paper/1/ITEM123)",
        libraryID: 1,
        itemKey: "ITEM123",
        action: "detail",
        from: 29,
        to: 59,
      },
    });

    expect(occurrences[1]).toEqual({
      file: undefined,
      filePath: "Notes/test.md",
      line: 2,
      ch: 69,
      lineText: "In this section we reference [a](unizero://paper/1/ITEM123) and also [a](unizero://paper/1/ITEM456.md).",
      token: {
        raw: "[a](unizero://paper/1/ITEM456.md)",
        libraryID: 1,
        itemKey: "ITEM456",
        action: "markdown",
        from: 69,
        to: 102,
      },
    });

    expect(occurrences[2]).toEqual({
      file: undefined,
      filePath: "Notes/test.md",
      line: 5,
      ch: 26,
      lineText: "A line with PDF citation: [a](unizero://paper/2/PDF999.pdf?page=42) at page 42.",
      token: {
        raw: "[a](unizero://paper/2/PDF999.pdf?page=42)",
        libraryID: 2,
        itemKey: "PDF999",
        action: "pdf",
        page: 42,
        from: 26,
        to: 67,
      },
    });
  });

  it("handles text with no citations", () => {
    const text = "Just plain text\nwith multiple lines\nand an email user@domain.com";
    const occurrences = scanTextCitations(text, { filePath: "Notes/plain.md" });
    expect(occurrences).toEqual([]);
  });

  it("handles multiple occurrences of the same paper on different lines", () => {
    const text = `Line 1: [a](unizero://paper/1/SAMEKEY1)
Line 2: some notes
Line 3: referring back to [a](unizero://paper/1/SAMEKEY1) again.`;
    const occurrences = scanTextCitations(text, { filePath: "Notes/repeat.md" });
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].line).toBe(0);
    expect(occurrences[0].token.itemKey).toBe("SAMEKEY1");
    expect(occurrences[1].line).toBe(2);
    expect(occurrences[1].token.itemKey).toBe("SAMEKEY1");
  });
});

describe("scanTextCitations and code", () => {
  it("skips citations inside fenced code blocks", () => {
    const text = [
      "[a](unizero://paper/1/BEFORE)",
      "````md",
      "[a](unizero://paper/1/INSIDE.pdf?page=3)",
      "```",
      "[a](unizero://paper/1/STILLIN)",
      "````",
      "[a](unizero://paper/1/AFTER)",
      "~~~",
      "[a](unizero://paper/1/TILDE)",
      "~~~",
    ].join("\n");
    const keys = scanTextCitations(text, { filePath: "a.md" }).map((o) => o.token.itemKey);
    expect(keys).toEqual(["BEFORE", "AFTER"]);
  });

  it("skips inline code but keeps offsets of citations beside it", () => {
    const line = "see `[a](unizero://paper/1/CODE)` and ``[a](unizero://paper/1/DOUBLE)`` then [a](unizero://paper/1/REAL)";
    const [only, ...rest] = scanTextCitations(line, { filePath: "a.md" });
    expect(rest).toEqual([]);
    expect(only.token.itemKey).toBe("REAL");
    expect(only.ch).toBe(line.indexOf("[a](unizero://paper/1/REAL)"));
    expect(only.lineText).toBe(line);
  });
});

describe("scanCanvasCitations", () => {
  it("extracts citations from Obsidian Canvas cards and preserves node IDs", () => {
    const canvasData = {
      nodes: [
        {
          id: "node-text-1",
          type: "text",
          text: "“Underreaction (PEAD)—robustness...” ([a](unizero://paper/1/H4KAG04R))\nSecond line citing [a](unizero://paper/1/OTHER999.md)",
        },
        {
          id: "node-file-1",
          type: "file",
          file: "some-file.md",
        },
        {
          id: "node-group-1",
          type: "group",
          label: "Group referencing [a](unizero://paper/1/H4KAG04R.pdf?page=15)",
        },
      ],
      edges: [],
    };

    const occurrences = scanCanvasCitations(JSON.stringify(canvasData), {
      filePath: "11_Canvas/test.canvas",
    });

    expect(occurrences).toHaveLength(3);

    expect(occurrences[0].token.itemKey).toBe("H4KAG04R");
    expect(occurrences[0].nodeId).toBe("node-text-1");
    expect(occurrences[0].line).toBe(0);

    expect(occurrences[1].token.itemKey).toBe("OTHER999");
    expect(occurrences[1].token.action).toBe("markdown");
    expect(occurrences[1].nodeId).toBe("node-text-1");
    expect(occurrences[1].line).toBe(1);

    expect(occurrences[2].token.itemKey).toBe("H4KAG04R");
    expect(occurrences[2].token.action).toBe("pdf");
    expect(occurrences[2].token.page).toBe(15);
    expect(occurrences[2].nodeId).toBe("node-group-1");
  });
});



describe("isIndexedNote", () => {
  it("indexes vault Markdown and Canvas notes only", () => {
    expect(isIndexedNote({ path: "Academic/Notes.canvas", extension: "canvas" })).toBe(true);
    expect(isIndexedNote({ path: "Notes/test.md", extension: "md" })).toBe(true);
    expect(isIndexedNote({ path: "Papers/a.pdf", extension: "pdf" })).toBe(false);
  });

  it("leaves out files Obsidian opened from outside the vault", () => {
    expect(isIndexedNote({
      path: "file:C:/Users/me/Zotero/storage/LL8AZJIF/Paper.canvas", extension: "canvas",
    })).toBe(false);
    expect(isIndexedNote({
      path: "file:/Users/me/Zotero/storage/LL8AZJIF/Paper.canvas", extension: "canvas",
    })).toBe(false);
  });
});
