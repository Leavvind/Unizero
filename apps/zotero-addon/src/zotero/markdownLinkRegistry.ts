/**
 * Persistent Obsidian URL bound to each converted Zotero paper.
 *
 * The user-facing link is deliberately independent of Zotero's local attachment
 * path. Zotero still needs that path to own the generated attachment, but opening
 * and editing the note target uses only the URL stored here:
 *
 *   <Zotero data directory>/unizero/markdown-links/<libraryID>.json
 */

import { config } from "../../package.json";

const REGISTRY_SCHEMA = 2;

export interface MarkdownLinkBinding {
  libraryID: number;
  itemKey: string;
  url: string;
  updatedAt: number;
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
  const url = String(value.url || "").trim();
  if (!url) { return; }
  return {
    libraryID,
    itemKey,
    url,
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

/** Default URL generated for a conversion. No absolute path participates. */
export function defaultMarkdownUrl(item: Zotero.Item, vault: string): string {
  const key = String(item.key || "").trim();
  if (!key) { return ""; }
  const encodedVault = String(vault || "").trim();
  return "obsidian://adv-uri?" +
    (encodedVault ? `vault=${encodeURIComponent(encodedVault)}&` : "") +
    `uid=${encodeURIComponent(key)}`;
}

export function validateMarkdownUrl(value: string): string {
  const url = String(value || "").trim();
  if (!/^obsidian:\/\/\S+$/i.test(url)) {
    throw new Error("The Markdown link must be an obsidian:// URL");
  }
  return url;
}

export async function readMarkdownLink(
  item: Zotero.Item,
): Promise<MarkdownLinkBinding | undefined> {
  const libraryID = Number(item.libraryID);
  const pending = writes.get(libraryID);
  if (pending) {
    try {
      await pending;
    } catch {
      // The previous complete document is still useful after a failed write.
    }
  }
  const document = await loadDocument(libraryID);
  return validBinding(document.items[item.key], libraryID, item.key);
}

/** Save an explicitly edited URL. */
export async function recordMarkdownLink(
  item: Zotero.Item,
  value: string,
): Promise<MarkdownLinkBinding> {
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  const binding: MarkdownLinkBinding = {
    libraryID,
    itemKey,
    url: validateMarkdownUrl(value),
    updatedAt: Date.now(),
  };

  const write = (writes.get(libraryID) || Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const document = await loadDocument(libraryID);
      const next: RegistryDocument = {
        ...document,
        updatedAt: binding.updatedAt,
        items: { ...document.items, [itemKey]: binding },
      };
      await persistDocument(next);
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
 * Ensure conversion/legacy discovery has a URL without overwriting a URL the
 * user already edited.
 */
export async function ensureMarkdownLink(
  item: Zotero.Item,
  generatedUrl: string,
  options: { upgradeLegacyUid?: boolean } = {},
): Promise<MarkdownLinkBinding> {
  const existing = await readMarkdownLink(item);
  if (!existing) {
    return recordMarkdownLink(item, generatedUrl);
  }
  if (!options.upgradeLegacyUid) {
    return existing;
  }

  try {
    const url = new URL(existing.url);
    const legacyUid = `unizero-${item.libraryID}-${item.key}`;
    if (
      url.protocol === "obsidian:" &&
      url.hostname === "adv-uri" &&
      url.searchParams.get("uid") === legacyUid
    ) {
      url.searchParams.set("uid", String(item.key));
      return recordMarkdownLink(item, url.toString());
    }
  } catch {
    // validateMarkdownUrl intentionally accepts every obsidian:// action, not
    // only URLs understood by the platform URL parser. Preserve such edits.
  }
  return existing;
}
