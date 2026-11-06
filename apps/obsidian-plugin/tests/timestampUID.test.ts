import { describe, expect, it } from "vitest";
import { timestampUID, uniqueTimestampUID, VaultIdentity } from "../src/vaultIdentity";

describe("timestampUID", () => {
  it("formats local time as YYYYMMDDHHmmss", () => {
    expect(timestampUID(new Date(2026, 10, 6, 12, 0, 39))).toBe("20261106120039");
    expect(timestampUID(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102030405");
  });
});

describe("uniqueTimestampUID", () => {
  it("moves a second forward past UIDs already in use", () => {
    const taken = new Set(["20261106120039", "20261106120040"]);
    expect(uniqueTimestampUID(new Date(2026, 10, 6, 12, 0, 39), (uid) => taken.has(uid))).toBe("20261106120041");
    expect(uniqueTimestampUID(new Date(2026, 10, 6, 12, 0, 59), () => false)).toBe("20261106120059");
  });
});

describe("VaultIdentity lookups", () => {
  const identity = new VaultIdentity(() => ({ vaultID: "v", uidProperty: "uid", uidSource: "property", uidFilenamePattern: "" }));
  identity.update("a/Alpha.md", "---\nuid: \"1\"\n---\n");
  identity.update("a/Beta.md", "---\nuid: \"2\"\n---\n");
  identity.update("b/Gamma.md", "");

  it("stops searching at the limit and matches every term", () => {
    expect(identity.search("a/", 1).map((n) => n.path)).toEqual(["a/Alpha.md"]);
    expect(identity.search("a/ 2").map((n) => n.path)).toEqual(["a/Beta.md"]);
    expect(identity.search("", Infinity)).toHaveLength(3);
    expect(identity.search("a", 0)).toEqual([]);
  });

  it("lists UIDs in use, leaving out the given note", () => {
    expect([...identity.usedUIDs()].sort()).toEqual(["1", "2"]);
    expect([...identity.usedUIDs("a/Alpha.md")]).toEqual(["2"]);
  });
});
