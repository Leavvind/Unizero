import type { App, TFile } from "obsidian";
import { paperRefKey, type PaperRef } from "./citation";
import type { CanvasLinkStore } from "./actions";

/** Keep titles safe across desktop filesystems and leave room for suffixes. */
export function canvasBasename(paper: PaperRef & { title?: string }): string {
  let name = (paper.title || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  const encoder = new TextEncoder();
  while (encoder.encode(name).length > 180) {
    name = Array.from(name).slice(0, -1).join("");
  }
  name = name.replace(/[. ]+$/, "");
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return `Paper ${paper.libraryID}-${paper.itemKey}`;
  }
  return name;
}

// Rapid clicks from different surfaces must create only one Canvas per paper.
const pending = new WeakMap<App, Map<string, Promise<TFile>>>();
const reservedPaths = new WeakMap<App, Set<string>>();

export async function createCanvasForPaper(
  app: App,
  paper: PaperRef & { title?: string },
  links: CanvasLinkStore,
): Promise<TFile> {
  let creations = pending.get(app);
  if (!creations) {
    creations = new Map();
    pending.set(app, creations);
  }
  const key = paperRefKey(paper);
  const existing = creations.get(key);
  if (existing) { return existing; }
  const creation = (async () => {
    let reserved = reservedPaths.get(app);
    if (!reserved) {
      reserved = new Set();
      reservedPaths.set(app, reserved);
    }
    const folder = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || "");
    const prefix = folder.path === "/" || !folder.path ? "" : `${folder.path}/`;
    const basename = canvasBasename(paper);
    let path = `${prefix}${basename}.canvas`;
    let suffix = 1;
    while (reserved.has(path) || app.vault.getAbstractFileByPath(path)) {
      path = `${prefix}${basename} (${suffix++}).canvas`;
    }
    reserved.add(path);
    try {
      const file = await app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }));
      await links.set(key, file.path);
      return file;
    } finally {
      reserved.delete(path);
    }
  })();
  creations.set(key, creation);
  try {
    return await creation;
  } finally {
    creations.delete(key);
  }
}
