import type { LinkSource } from "../zotero/linkSources";

export class SourceDirectoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface LinkSourcePage {
  scan: string; scope: number[]; items: LinkSource[]; total: number; complete: boolean; nextOffset?: number;
}
/** Pagination is one expiring read snapshot, independent of Zotero mutations. */
export class LinkSourceDirectory {
  private readonly scans = new Map<string, { expires: number; scope: number[]; items: LinkSource[] }>();
  private serial = 0;
  constructor(private readonly libraries: (requested?: number[]) => number[],
    private readonly read: (scope: number[]) => Promise<LinkSource[]>, private readonly now: () => number = Date.now) {}
  async page(query: Record<string, string | undefined>): Promise<LinkSourcePage> {
    for (const [id, scan] of this.scans) { if (scan.expires <= this.now()) { this.scans.delete(id); } }
    let id = query.scan || "";
    const offset = Number(query.offset || "0"), limit = Number(query.limit || "100");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new SourceDirectoryError(400, "Invalid source page");
    }
    if (!id) {
      if (offset) { throw new SourceDirectoryError(400, "A continuation requires its scan ID"); }
      const requested = query.libraries ? query.libraries.split(",").map(Number) : undefined;
      if (requested?.some((n) => !Number.isSafeInteger(n) || n < 1)) { throw new SourceDirectoryError(400, "Invalid libraries"); }
      let scope: number[];
      try { scope = this.libraries(requested); } catch (error) { throw new SourceDirectoryError(400, (error as Error).message); }
      const items = await this.read(scope); // Failed reads never publish a partial snapshot.
      id = `${this.now().toString(36)}-${++this.serial}`;
      while (this.scans.size >= 4) { this.scans.delete(this.scans.keys().next().value!); }
      this.scans.set(id, { expires: this.now() + 300000, scope, items });
    }
    const scan = this.scans.get(id);
    if (!scan) { throw new SourceDirectoryError(409, "Source scan expired; restart the scan"); }
    if (offset > scan.items.length) { throw new SourceDirectoryError(400, "Source offset exceeds the scan"); }
    const items = scan.items.slice(offset, offset + limit), next = offset + items.length;
    return { scan: id, scope: scan.scope, items, complete: next === scan.items.length,
      nextOffset: next < scan.items.length ? next : undefined, total: scan.items.length };
  }
  clear(): void { this.scans.clear(); }
}
