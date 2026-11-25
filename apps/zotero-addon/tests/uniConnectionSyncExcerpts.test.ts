import { describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/localStorage", () => ({ localStorage: {} }));
vi.mock("../src/modules/referencesApi", () => ({ fetchReferencesByIdentifiers: vi.fn() }));
vi.mock("../src/modules/literatureRelations", () => ({ invalidateLibraryMembership: vi.fn() }));
vi.mock("../src/modules/uniConnection", () => ({ uniConnection: {} }));
vi.mock("../src/modules/itemIdentifiers", () => ({
  readItemPaperIdentifiers: (item: any) => item.__ids || {},
}));

import { UniConnectionSync } from "../src/modules/uniConnectionSync";

function harness(items: Record<number, any>, record?: unknown) {
  let observer: any;
  const connection = {
    ingestItem: vi.fn(async () => true),
    ingestExcerptNote: vi.fn(async () => true),
    retract: vi.fn(),
    retractItemID: vi.fn(() => undefined),
    retractExcerptNote: vi.fn(),
  };
  const sync = new UniConnectionSync({
    notifier: {
      registerObserver: (value: any) => { observer = value; return "id"; },
      unregisterObserver: () => undefined,
    },
    cache: { readRecordDirect: vi.fn(async () => record), set: async () => undefined },
    connection,
    fetchReferences: async () => null,
    getItem: async (id) => items[id],
    invalidateMembership: () => undefined,
    cacheEnabled: () => false,
  });
  sync.register();
  return { connection, sync, notify: (event: string, ids: number[]) => observer.notify(event, "item", ids, {}) };
}

const note = (id: number, deleted = false) => ({
  id, libraryID: 1, deleted, isNote: () => true, isRegularItem: () => false,
});

describe("UniConnectionSync and excerpt notes", () => {
  it("re-reads a modified note without building an unbuilt library", async () => {
    const { connection, notify } = harness({ 5: note(5) });
    await notify("modify", [5]);
    expect(connection.ingestExcerptNote).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), false);
    expect(connection.ingestItem).not.toHaveBeenCalled();
  });

  it("retracts a trashed or deleted note", async () => {
    const { connection, notify } = harness({ 6: note(6, true) });
    await notify("modify", [6]);
    await notify("delete", [7]);
    expect(connection.retractExcerptNote.mock.calls).toEqual([[6], [7]]);
    expect(connection.ingestExcerptNote).not.toHaveBeenCalled();
  });
});

describe("UniConnectionSync and modified papers", () => {
  it("reads a modified paper's shard once and hands it to the index", async () => {
    const paper = { id: 8, libraryID: 1, key: "P", deleted: false, isNote: () => false, isRegularItem: () => true };
    const record = { references: [] };
    const { connection, sync, notify } = harness({ 8: paper }, record);
    await notify("modify", [8]);
    expect((sync as any).cache.readRecordDirect).toHaveBeenCalledTimes(1);
    expect(connection.ingestItem).toHaveBeenCalledWith(paper, false, { record });
  });
});
