import { describe, expect, it } from "vitest";
import { scanCanvasCitations, scanTextCitations } from "../src/vaultIndex";

describe("scanTextCitations", () => {
  it("extracts citations from multi-line text with line numbers and character offsets", () => {
    const text = `# Title

In this section we reference @1/ITEM123 and also @1/ITEM456.md.

Some other line with no citations.
A line with PDF citation: @2/PDF999.pdf:42 at page 42.
`;

    const occurrences = scanTextCitations(text, { filePath: "Notes/test.md" });

    expect(occurrences).toHaveLength(3);

    expect(occurrences[0]).toEqual({
      file: undefined,
      filePath: "Notes/test.md",
      line: 2,
      ch: 29,
      lineText: "In this section we reference @1/ITEM123 and also @1/ITEM456.md.",
      token: {
        raw: "@1/ITEM123",
        libraryID: 1,
        itemKey: "ITEM123",
        action: "detail",
        from: 29,
        to: 39,
      },
    });

    expect(occurrences[1]).toEqual({
      file: undefined,
      filePath: "Notes/test.md",
      line: 2,
      ch: 49,
      lineText: "In this section we reference @1/ITEM123 and also @1/ITEM456.md.",
      token: {
        raw: "@1/ITEM456.md",
        libraryID: 1,
        itemKey: "ITEM456",
        action: "markdown",
        from: 49,
        to: 62,
      },
    });

    expect(occurrences[2]).toEqual({
      file: undefined,
      filePath: "Notes/test.md",
      line: 5,
      ch: 26,
      lineText: "A line with PDF citation: @2/PDF999.pdf:42 at page 42.",
      token: {
        raw: "@2/PDF999.pdf:42",
        libraryID: 2,
        itemKey: "PDF999",
        action: "pdf",
        page: 42,
        from: 26,
        to: 42,
      },
    });
  });

  it("handles text with no citations", () => {
    const text = "Just plain text\nwith multiple lines\nand an email user@domain.com";
    const occurrences = scanTextCitations(text, { filePath: "Notes/plain.md" });
    expect(occurrences).toEqual([]);
  });

  it("handles multiple occurrences of the same paper on different lines", () => {
    const text = `Line 1: @1/SAMEKEY1
Line 2: some notes
Line 3: referring back to @1/SAMEKEY1 again.`;
    const occurrences = scanTextCitations(text, { filePath: "Notes/repeat.md" });
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].line).toBe(0);
    expect(occurrences[0].token.itemKey).toBe("SAMEKEY1");
    expect(occurrences[1].line).toBe(2);
    expect(occurrences[1].token.itemKey).toBe("SAMEKEY1");
  });
});

describe("scanCanvasCitations", () => {
  it("extracts citations from Obsidian Canvas cards and preserves node IDs", () => {
    const canvasData = {
      nodes: [
        {
          id: "node-text-1",
          type: "text",
          text: "“Underreaction (PEAD)—robustness...” (@1/H4KAG04R)\nSecond line citing @1/OTHER999.md",
        },
        {
          id: "node-file-1",
          type: "file",
          file: "some-file.md",
        },
        {
          id: "node-group-1",
          type: "group",
          label: "Group referencing @1/H4KAG04R.pdf:15",
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


