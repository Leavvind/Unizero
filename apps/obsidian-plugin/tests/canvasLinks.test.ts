import { describe, expect, it } from "vitest";
import { renameCanvasLinks } from "../src/canvasLinks";

describe("Canvas bindings after vault renames", () => {
  it("updates every paper linked to a renamed or moved Canvas across libraries", () => {
    const links = {
      "1/ABCD1234": "Notes/Paper.canvas",
      "2/ABCD1234": "Notes/Paper.canvas",
      "1/OTHER": "Notes/Other.canvas",
    };
    expect(renameCanvasLinks(links, "Notes/Paper.canvas", "Archive/New.canvas", false)).toBe(true);
    expect(links).toEqual({
      "1/ABCD1234": "Archive/New.canvas",
      "2/ABCD1234": "Archive/New.canvas",
      "1/OTHER": "Notes/Other.canvas",
    });
  });

  it("follows parent-folder moves without touching similarly prefixed folders", () => {
    const links = {
      "1/A": "Notes/Paper.canvas",
      "1/B": "Notes/Subfolder/Paper.canvas",
      "1/C": "Notes Extra/Paper.canvas",
    };
    expect(renameCanvasLinks(links, "Notes", "Archive/Reading", true)).toBe(true);
    expect(links).toEqual({
      "1/A": "Archive/Reading/Paper.canvas",
      "1/B": "Archive/Reading/Subfolder/Paper.canvas",
      "1/C": "Notes Extra/Paper.canvas",
    });
    // Some hosts also report descendant renames; applying them is harmless.
    expect(renameCanvasLinks(links, "Notes/Paper.canvas", "Archive/Reading/Paper.canvas", false)).toBe(false);
    expect(renameCanvasLinks(links, "Archive/Reading", "Reading", true)).toBe(true);
    expect(links["1/B"]).toBe("Reading/Subfolder/Paper.canvas");
  });

  it("ignores unrelated and unchanged paths", () => {
    const links = { "1/A": "Notes/Paper.canvas" };
    expect(renameCanvasLinks(links, "Other.canvas", "New.canvas", false)).toBe(false);
    expect(renameCanvasLinks(links, "Notes", "New", false)).toBe(false);
    expect(renameCanvasLinks(links, "Notes", "Notes", true)).toBe(false);
    expect(links["1/A"]).toBe("Notes/Paper.canvas");
  });
});
