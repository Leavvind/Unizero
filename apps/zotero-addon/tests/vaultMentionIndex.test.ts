import { describe, expect, it } from "vitest";
import {
  parseVaultSnapshot,
  VaultMentionIndex,
  VaultSnapshotError,
  vaultNoteKey,
} from "../src/modules/vaultMentionIndex";

const pdf = "zotero://open-pdf/library/items/PDFA0001?page=3&annotation=ANNO0001";
const mention = (overrides: Record<string, unknown> = {}) => ({
  libraryID: 1, itemKey: "BKEY0001", path: "Files/Literature.canvas", title: "Literature", format: "canvas",
  line: 2, nodeId: "card1", text: "Cox finds a negative drift.", pdf: [pdf, "https://example.com"], time: 500,
  ...overrides,
});
const body = (mentions: unknown[], overrides: Record<string, unknown> = {}) =>
  ({ vaultID: "vault-1", vaultName: "Notes", generatedAt: 100, mentions, ...overrides });

describe("vault mention snapshots", () => {
  it("parses a snapshot, keeping only Zotero's own PDF anchors", () => {
    const snapshot = parseVaultSnapshot(body([mention(), mention({ itemKey: "CKEY0001", line: 7, nodeId: undefined })]), 200);
    expect(snapshot).toMatchObject({ vaultID: "vault-1", vaultName: "Notes", generatedAt: 100, receivedAt: 200 });
    expect(snapshot.mentions[0]).toMatchObject({
      cited: { libraryID: 1, itemKey: "BKEY0001" }, line: 2, nodeId: "card1", pdf: [pdf], time: 500,
      note: { vaultID: "vault-1", vaultName: "Notes", path: "Files/Literature.canvas", title: "Literature", format: "canvas" },
    });
    // One note object per path.
    expect(snapshot.mentions[1].note).toBe(snapshot.mentions[0].note);
    expect(snapshot.mentions[1].nodeId).toBeUndefined();
  });

  it("rejects a malformed body as a whole", () => {
    expect(() => parseVaultSnapshot(null, 1)).toThrow(VaultSnapshotError);
    expect(() => parseVaultSnapshot(body([], { vaultID: "a/b" }), 1)).toThrow(VaultSnapshotError);
    expect(() => parseVaultSnapshot(body([mention({ itemKey: "../x" })]), 1)).toThrow(/itemKey/);
    expect(() => parseVaultSnapshot(body([mention({ libraryID: 0 })]), 1)).toThrow(/libraryID/);
    expect(() => parseVaultSnapshot(body([mention({ format: "pdf" })]), 1)).toThrow(/format/);
    expect(() => parseVaultSnapshot(body([mention({ line: -1 })]), 1)).toThrow(/line/);
    expect(() => parseVaultSnapshot(body("nope" as unknown as unknown[]), 1)).toThrow(/mentions/);
  });

  it("groups a paper's Citations by note and replaces a Vault's snapshot wholesale", () => {
    const index = new VaultMentionIndex();
    index.put(parseVaultSnapshot(body([
      mention({ line: 9, nodeId: undefined, path: "A.md", title: "A", format: "md" }),
      mention(),
      mention({ line: 1, nodeId: undefined, path: "A.md", title: "A", format: "md" }),
      mention({ itemKey: "CKEY0001" }),
    ]), 1));
    index.put(parseVaultSnapshot(body([mention({ path: "Other.md", format: "md" })], { vaultID: "vault-2", vaultName: "Other" }), 1));
    const groups = index.citations({ libraryID: 1, itemKey: "BKEY0001" });
    expect(groups.map((group) => [group.note.vaultID, group.note.path, group.mentions.map((each) => each.line)])).toEqual([
      ["vault-1", "A.md", [1, 9]],
      ["vault-1", "Files/Literature.canvas", [2]],
      ["vault-2", "Other.md", [2]],
    ]);
    index.put(parseVaultSnapshot(body([]), 2));
    expect(index.citations({ libraryID: 1, itemKey: "BKEY0001" }).map((group) => group.note.vaultID)).toEqual(["vault-2"]);
    expect(index.mentions()).toHaveLength(1);
    // An emptied Vault is forgotten, so the status bar no longer lists it.
    expect(index.snapshots().map((snapshot) => snapshot.vaultID)).toEqual(["vault-2"]);
  });

  it("round-trips through its cache file and skips an unreadable Vault", () => {
    const index = new VaultMentionIndex();
    index.put(parseVaultSnapshot(body([mention()]), 300));
    const stored = JSON.parse(JSON.stringify(index.toJSON()));
    stored.vaults.push({ vaultID: "", mentions: [] });
    const restored = new VaultMentionIndex();
    restored.restore(stored);
    expect(restored.snapshots()).toHaveLength(1);
    expect(restored.snapshots()[0]).toMatchObject({ vaultID: "vault-1", receivedAt: 300, generatedAt: 100 });
    expect(restored.mentions()[0]).toMatchObject({ line: 2, nodeId: "card1", pdf: [pdf], time: 500 });
    restored.restore({ version: 2 });
    expect(restored.snapshots()).toHaveLength(1);
  });

  it("keys notes apart from papers", () => {
    expect(vaultNoteKey({ vaultID: "v", path: "a/b.md" })).toBe("vault:v:a/b.md");
  });
});
