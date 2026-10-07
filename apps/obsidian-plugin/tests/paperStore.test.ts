import { describe, expect, it, vi } from "vitest";
import type { BridgePaper, UnizeroBridge } from "../src/bridge";
import { PaperStore } from "../src/paperStore";

vi.mock("../src/bridge", () => ({ BridgeError: class extends Error { status = 404; } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ref = { libraryID: 1, itemKey: "ABCD1234" };
const paper = (title: string) => ({ ...ref, title } as BridgePaper);

describe("paper cache request ownership", () => {
  it("deduplicates simultaneous loads", async () => {
    const request = deferred<BridgePaper>();
    const load = vi.fn(() => request.promise);
    const store = new PaperStore({ paper: load } as unknown as UnizeroBridge);
    const first = store.load(ref);
    const second = store.load(ref);
    request.resolve(paper("Title"));
    expect(await first).toEqual(await second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the fresh response when a request from before refresh finishes last", async () => {
    const oldRequest = deferred<BridgePaper>();
    const newRequest = deferred<BridgePaper>();
    const load = vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const store = new PaperStore({ paper: load } as unknown as UnizeroBridge);
    const listener = vi.fn();
    store.subscribe(ref, listener);
    const oldLoad = store.load(ref);
    store.invalidate();
    const freshLoad = store.load(ref);
    newRequest.resolve(paper("Fresh"));
    await freshLoad;
    oldRequest.resolve(paper("Stale"));
    await oldLoad;
    expect(store.peek(ref)).toEqual({ status: "ready", paper: paper("Fresh") });
    expect(listener).not.toHaveBeenCalledWith({ status: "ready", paper: paper("Stale") });
  });

  it("does not resurrect invalidated entries without subscribers", async () => {
    const request = deferred<BridgePaper>();
    const store = new PaperStore({ paper: () => request.promise } as unknown as UnizeroBridge);
    const loading = store.load(ref);
    store.invalidate();
    request.resolve(paper("Stale"));
    await loading;
    expect(store.peek(ref)).toBeUndefined();
  });
});
