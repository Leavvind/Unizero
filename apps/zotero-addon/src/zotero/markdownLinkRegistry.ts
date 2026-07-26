/**
 * Persistent binding between a Zotero paper and its published Markdown note.
 *
 * Zotero remains canonical for the attachment itself. This registry records the
 * extra identity Zotero does not know about: the note's frontmatter `uid`. It is
 * kept outside the installed add-on under:
 *
 *   <Zotero data directory>/unizero/markdown-links/<libraryID>.json
 *
 * One document per library keeps group-library identity explicit and lets writes
 * for unrelated libraries proceed independently.
 */

import { config } from "../../package.json";

const REGISTRY_SCHEMA = 1;
const FRONTMATTER_READ_LIMIT = 16_384;
const FRONTMATTER_UID = /^\s*uid\s*:\s*(.*?)\s*$/m;

export interface MarkdownLinkBinding {
  libraryID: number;
  itemKey: string;
  attachmentKey: string;
  path: string;
  uid: string;
  updatedAt: number;
}

export interface ResolvedMarkdownLink extends MarkdownLinkBinding {
  exists: boolean;
}

interface RegistryDocument {
  schema: number;
  libraryID: number;
  updatedAt: number;
  items: Record<string, MarkdownLinkBinding>;
}

const documents = new Map<number, Promise<RegistryDocument>>();
const writes = new Map<number, Promise<void>>();

function dataDirectory(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  if (typeof dir === "string" && dir) { return dir; }
  return Zotero.getTempDirectory().parent.path;
}

function registryPath(libraryID: number): string {
  return PathUtils.join(
    dataDirectory(),
    config.addonRef,
    "markdown-links",
    `${libraryID}.json`,
  );
}

function emptyDocument(libraryID: number): RegistryDocument {
  return {
    schema: REGISTRY_SCHEMA,
    libraryID,
    updatedAt: 0,
    items: {},
  };
}

function validBinding(
  value: any,
  libraryID: number,
  itemKey: string,
): MarkdownLinkBinding | undefined {
  if (!value || typeof value !== "object") { return; }
  if (Number(value.libraryID) !== libraryID || String(value.itemKey) !== itemKey) {
    return;
  }
  return {
    libraryID,
    itemKey,
    attachmentKey: String(value.attachmentKey || ""),
    path: String(value.path || ""),
    uid: String(value.uid || ""),
    updatedAt: Number(value.updatedAt || 0),
  };
}

async function loadDocument(libraryID: number): Promise<RegistryDocument> {
  let loading = documents.get(libraryID);
  if (!loading) {
    loading = (async () => {
      try {
        const parsed = JSON.parse(
          await IOUtils.readUTF8(registryPath(libraryID)) as string,
        );
        if (
          parsed &&
          typeof parsed === "object" &&
          Number(parsed.libraryID) === libraryID &&
          parsed.items &&
          typeof parsed.items === "object"
        ) {
          return {
            ...emptyDocument(libraryID),
            ...parsed,
            schema: REGISTRY_SCHEMA,
            libraryID,
            items: parsed.items,
          };
        }
      } catch (error) {
        if (!isMissingFile(error)) {
          ztoolkit.log(`Markdown link registry unreadable for ${libraryID}: ${error}`);
        }
      }
      return emptyDocument(libraryID);
    })();
    documents.set(libraryID, loading);
  }
  return loading;
}

async function persistDocument(document: RegistryDocument): Promise<void> {
  const path = registryPath(document.libraryID);
  await IOUtils.makeDirectory(PathUtils.parent(path)!, {
    createAncestors: true,
    ignoreExisting: true,
  });
  await IOUtils.writeUTF8(path, JSON.stringify(document), {
    tmpPath: `${path}.tmp`,
  });
}

function isMissingFile(error: any): boolean {
  return error?.name === "NotFoundError" || error?.name === "NotAllowedError";
}

/**
 * Read a scalar YAML `uid` without treating it as a number.
 *
 * Advanced URI accepts UUID/text identifiers as well as numeric-looking ones.
 * Returning a string here preserves leading zeroes and gives URI construction one
 * representation regardless of how Obsidian displays the property.
 */
export function uidFromMarkdownFrontmatter(source: string): string {
  const match = FRONTMATTER_UID.exec(String(source || ""));
  if (!match) { return ""; }
  let value = match[1].trim();
  const quote = value[0];
  if ((quote === "'" || quote === "\"") && value.endsWith(quote)) {
    value = value.slice(1, -1).trim();
  }
  if (!value || /^(?:null|~)$/i.test(value)) { return ""; }
  return value;
}

export async function markdownUidFromFile(path: string): Promise<string> {
  const head = await Zotero.File.getContentsAsync(
    path,
    "utf-8",
    FRONTMATTER_READ_LIMIT,
  );
  return uidFromMarkdownFrontmatter(String(head));
}

export async function readMarkdownLinkBinding(
  item: Zotero.Item,
): Promise<MarkdownLinkBinding | undefined> {
  const libraryID = Number(item.libraryID);
  const pending = writes.get(libraryID);
  if (pending) {
    try {
      await pending;
    } catch {
      // The last complete registry is still useful after a failed write.
    }
  }
  const document = await loadDocument(libraryID);
  return validBinding(document.items[item.key], libraryID, item.key);
}

export async function assertMarkdownUidAvailable(
  item: Zotero.Item,
  uid: string,
): Promise<void> {
  if (!uid) { return; }
  const libraryID = Number(item.libraryID);
  const pending = writes.get(libraryID);
  if (pending) { await pending; }
  const document = await loadDocument(libraryID);
  for (const [otherKey, other] of Object.entries(document.items)) {
    if (otherKey !== item.key && other?.uid === uid) {
      throw new Error(
        `Markdown uid '${uid}' is already linked to Zotero item ${otherKey}`,
      );
    }
  }
}

/**
 * Persist the exact note identity observed after conversion or an explicit link
 * change. Passing `uid` avoids reading a file twice when the caller already
 * inspected it.
 */
export async function recordMarkdownLink(
  item: Zotero.Item,
  attachment: Zotero.Item,
  path: string,
  uid?: string,
): Promise<MarkdownLinkBinding> {
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  const observedUid = uid === undefined
    ? await markdownUidFromFile(path)
    : String(uid || "");
  const binding: MarkdownLinkBinding = {
    libraryID,
    itemKey,
    attachmentKey: String(attachment.key || ""),
    path: String(path || ""),
    uid: observedUid,
    updatedAt: Date.now(),
  };

  const write = (writes.get(libraryID) || Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const document = await loadDocument(libraryID);
      for (const [otherKey, other] of Object.entries(document.items)) {
        if (observedUid && otherKey !== itemKey && other?.uid === observedUid) {
          throw new Error(
            `Markdown uid '${observedUid}' is already linked to Zotero item ${otherKey}`,
          );
        }
      }
      const next: RegistryDocument = {
        ...document,
        updatedAt: binding.updatedAt,
        items: { ...document.items, [itemKey]: binding },
      };
      await persistDocument(next);
      // Do not expose a binding in memory until its atomic disk write succeeds.
      documents.set(libraryID, Promise.resolve(next));
    });
  writes.set(libraryID, write);
  try {
    await write;
  } finally {
    if (writes.get(libraryID) === write) { writes.delete(libraryID); }
  }
  return binding;
}

/**
 * Reconcile Zotero's attachment path, the reachable Markdown frontmatter, and the
 * persisted binding.
 *
 * No path is changed here. A reachable legacy file is merely observed; an
 * unreachable attachment with no registry entry remains path-based until the user
 * explicitly changes its link.
 */
export async function resolveMarkdownLink(
  item: Zotero.Item,
  attachment: Zotero.Item,
): Promise<ResolvedMarkdownLink> {
  const existing = await attachment.getFilePathAsync();
  const attachmentPath = String(existing || attachment.getFilePath() || "");
  const binding = await readMarkdownLinkBinding(item);

  if (existing) {
    let uid = binding?.path === String(existing) ? binding.uid : "";
    try {
      uid = await markdownUidFromFile(String(existing));
    } catch (error) {
      ztoolkit.log(`Markdown frontmatter unreadable at ${existing}: ${error}`);
    }
    const changed =
      !binding ||
      binding.attachmentKey !== String(attachment.key || "") ||
      binding.path !== String(existing) ||
      binding.uid !== uid;
    const current = changed
      ? await recordMarkdownLink(item, attachment, String(existing), uid)
      : binding;
    return { ...current, exists: true };
  }

  if (
    binding &&
    binding.attachmentKey === String(attachment.key || "")
  ) {
    return { ...binding, exists: false };
  }

  const current = await recordMarkdownLink(
    item,
    attachment,
    attachmentPath,
    "",
  );
  return { ...current, exists: false };
}
