interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LocalStorage graph layout writes", () => {
  it("serialises both graph views through one library write chain", async () => {
    vi.resetModules();
    const firstWrite = deferred();
    const payloads: any[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const notFound = Object.assign(new Error("missing"), { name: "NotFoundError" });

    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      parent: (path: string) => path.slice(0, path.lastIndexOf("/")),
      filename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
    };
    (globalThis as any).IOUtils = {
      makeDirectory: vi.fn(async () => undefined),
      getChildren: vi.fn(async () => []),
      readUTF8: vi.fn(async () => { throw notFound; }),
      stat: vi.fn(async () => ({ lastModified: 0 })),
      move: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      writeUTF8: vi.fn(async (_path: string, body: string) => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        payloads.push(JSON.parse(body));
        if (payloads.length === 1) await firstWrite.promise;
        activeWrites -= 1;
      }),
    };
    const makeDeferred = () => {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      return { promise, resolve, reject };
    };
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "test-data" },
      Libraries: { userLibraryID: 1, get: () => undefined },
      Items: { getAll: async () => [] },
      Promise: { defer: makeDeferred },
    };
    (globalThis as any).ztoolkit = { log: vi.fn() };

    const { LocalStorage } = await import("../src/modules/localStorage");
    const store = new LocalStorage("layout-test");
    await store.lock.promise;

    const first = store.writeGraphLayout(1, {
      savedAt: 1,
      positions: { "1:A": [1, 2] },
    });
    await flush();
    const second = store.writeGraphLayout(1, {
      savedAt: 2,
      positions: { "1:A": [1, 2], "1:B": [3, 4] },
    });
    await flush();

    expect(payloads).toHaveLength(1);
    expect(maxActiveWrites).toBe(1);
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(payloads.map((payload) => payload.savedAt)).toEqual([1, 2]);
    expect(payloads[1].positions).toEqual({
      "1:A": [1, 2],
      "1:B": [3, 4],
    });
    expect(maxActiveWrites).toBe(1);
  });
});
