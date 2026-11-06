import type { CachedMetadata, Reference } from "obsidian";

/**
 * Native Obsidian links into a Vault note, read from what Obsidian has already
 * resolved. Obsidian owns the resolution; this module only reshapes it so the
 * Backlinks pane can list it beside UniZero links. It needs no UID.
 */
export type NativeLinkForm = "wikilink" | "embed" | "markdown" | "property" | "file";
export interface NativeBacklink {
  sourcePath: string;
  form: NativeLinkForm;
  /** The link as written; absent for a file-level entry. */
  raw?: string;
  /** Heading or block the link names, without the leading `#`. */
  subpath?: string;
  /** Zero-based position; absent for property links and file-level entries. */
  line?: number;
  ch?: number;
  lineText?: string;
  /** Frontmatter property holding the link. */
  key?: string;
  /** For a file-level entry: how many links Obsidian counted. */
  count?: number;
}
export interface NativeLinkHost {
  /** `metadataCache.resolvedLinks`: source path to destination path to count. */
  resolvedLinks: Record<string, Record<string, number>>;
  fileCache(path: string): Pick<CachedMetadata, "links" | "embeds" | "frontmatterLinks"> | null | undefined;
  /** `metadataCache.getFirstLinkpathDest`, as a path. */
  resolve(linkpath: string, sourcePath: string): string | undefined;
  read(path: string): Promise<string | undefined>;
}

function splitLink(link: string): { linkpath: string; subpath?: string } {
  const hash = link.indexOf("#");
  return hash < 0 ? { linkpath: link } : { linkpath: link.slice(0, hash), subpath: link.slice(hash + 1) || undefined };
}
function formOf(original: string, embed: boolean): NativeLinkForm {
  if (embed) { return "embed"; }
  return original.startsWith("[[") ? "wikilink" : "markdown";
}

/** Every native link into `targetPath`, ordered by source path and position. Self-links are left out. */
export async function nativeBacklinks(host: NativeLinkHost, targetPath: string): Promise<NativeBacklink[]> {
  const sources = Object.keys(host.resolvedLinks)
    .filter((source) => source !== targetPath && (host.resolvedLinks[source]?.[targetPath] || 0) > 0)
    .sort((a, b) => a.localeCompare(b));
  // Sources are independent, so their reads overlap; the order above is kept.
  return (await Promise.all(sources.map(async (sourcePath): Promise<NativeBacklink[]> => {
    const cache = host.fileCache(sourcePath);
    const pointsHere = (ref: Reference) => {
      const { linkpath } = splitLink(ref.link);
      return linkpath !== "" && host.resolve(linkpath, sourcePath) === targetPath;
    };
    const positioned: NativeBacklink[] = [];
    const refs = [...(cache?.links || []).map((ref) => ({ ref, embed: false })), ...(cache?.embeds || []).map((ref) => ({ ref, embed: true }))];
    for (const { ref, embed } of refs) {
      if (!pointsHere(ref)) { continue; }
      positioned.push({ sourcePath, form: formOf(ref.original, embed), raw: ref.original, subpath: splitLink(ref.link).subpath,
        line: ref.position.start.line, ch: ref.position.start.col });
    }
    positioned.sort((a, b) => a.line! - b.line! || a.ch! - b.ch!);
    const properties: NativeBacklink[] = (cache?.frontmatterLinks || []).filter(pointsHere)
      .map((ref) => ({ sourcePath, form: "property" as const, raw: ref.original, subpath: splitLink(ref.link).subpath, key: ref.key }));
    if (positioned.length) {
      const lines = (await host.read(sourcePath))?.split(/\r?\n/);
      for (const link of positioned) { link.lineText = lines?.[link.line!]; }
    }
    const found = [...properties, ...positioned];
    // Obsidian counted links this cache cannot place, as in a Canvas: keep the file.
    return found.length ? found : [{ sourcePath, form: "file" as const, count: host.resolvedLinks[sourcePath][targetPath] }];
  }))).flat();
}
