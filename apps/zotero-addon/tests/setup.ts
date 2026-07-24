// Minimal privileged globals the source modules reference at call time. Individual
// tests replace `Zotero.Items.getAll` with a fixture-backed reader (see helpers.ts).
(globalThis as any).Zotero = (globalThis as any).Zotero || {
  Libraries: { userLibraryID: 1, get: () => undefined },
  Items: { getAll: () => [] },
};
(globalThis as any).ztoolkit = (globalThis as any).ztoolkit || { log: () => {} };
