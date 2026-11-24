import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/uniConnection", () => ({ uniConnection: {} }));

vi.mock("../src/zotero/libraryScope", () => ({ libraryEditable: () => true }));

import { annotationsFromDrop, parseAnnotationDrop } from "../src/zotero/excerptAnnotations";

describe("parseAnnotationDrop", () => {
  it("reads a saved annotation dragged from the reader sidebar", () => {
    const raw = JSON.stringify([{
      id: "CET4ELBZ", type: "highlight", text: " Following Dick-Nielsen (2014) ",
      pageLabel: 7, sortIndex: "00006|000120|00300", color: "#ffd400",
      position: { pageIndex: 6, rects: [[1, 2, 3, 4]] }, attachmentItemID: 42,
    }]);
    expect(parseAnnotationDrop(raw)).toEqual([{
      key: "CET4ELBZ", attachmentItemID: 42, type: "highlight",
      text: "Following Dick-Nielsen (2014)", color: "#ffd400", pageLabel: "7",
      sortIndex: "00006|000120|00300", position: { pageIndex: 6, rects: [[1, 2, 3, 4]] },
    }]);
  });

  it("reads a text selection, which has no saved key", () => {
    const [entry] = parseAnnotationDrop(JSON.stringify({
      id: "temp-1", text: "Using the collected data,", position: { pageIndex: 6 }, attachmentItemID: "42",
    }));
    expect(entry).toMatchObject({ key: undefined, attachmentItemID: 42, text: "Using the collected data," });
  });

  it("drops what it cannot use instead of guessing", () => {
    expect(parseAnnotationDrop("not json")).toEqual([]);
    expect(parseAnnotationDrop(JSON.stringify([null, 3, { type: "ink" }]))).toEqual([]);
  });
});

describe("annotationsFromDrop", () => {
  const citing = { id: 1 } as any;
  const attachments: Record<number, any> = {
    42: { id: 42, libraryID: 1, parentItemID: 1 },
    43: { id: 43, libraryID: 1, parentItemID: 99 },
  };
  const selection = (attachmentItemID: number) =>
    ({ text: "Some passage", position: { pageIndex: 0 }, attachmentItemID });

  function install(saveFromJSON: (attachment: any, json: any) => Promise<any>) {
    (globalThis as any).ztoolkit = { log: vi.fn() };
    (globalThis as any).Zotero = {
      Items: { get: (id: number) => attachments[id] || false, getByLibraryAndKey: () => false },
      Annotations: { saveFromJSON: vi.fn(saveFromJSON) },
      DataObjectUtilities: { generateKey: () => "NEWKEY01" },
    };
    return (globalThis as any).Zotero.Annotations.saveFromJSON;
  }

  afterEach(() => {
    delete (globalThis as any).Zotero;
    delete (globalThis as any).ztoolkit;
  });

  it("refuses the whole drop before creating anything when one entry is foreign", async () => {
    const save = install(async () => ({ eraseTx: vi.fn() }));
    await expect(annotationsFromDrop([selection(42), selection(43)], citing))
      .rejects.toThrow("own PDFs");
    expect(save).not.toHaveBeenCalled();
  });

  it("erases highlights it created when a later one fails", async () => {
    const first = { eraseTx: vi.fn().mockResolvedValue(undefined) };
    let calls = 0;
    install(async () => {
      calls += 1;
      if (calls === 1) { return first; }
      throw new Error("disk full");
    });
    await expect(annotationsFromDrop([selection(42), selection(42)], citing)).rejects.toThrow("disk full");
    expect(first.eraseTx).toHaveBeenCalledOnce();
  });
});
