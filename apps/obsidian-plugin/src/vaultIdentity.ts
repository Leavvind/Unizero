import { isScalar, parseDocument } from "yaml";
import { validIdentity } from "./linkTarget";

export interface IdentitySettings { vaultID: string; uidProperty: string; uidSource: "property" | "filename"; uidFilenamePattern: string }
export interface NoteIdentity { path: string; title: string; uid?: string; error?: string }
export function readDocumentUID(text: string, path: string, settings: IdentitySettings): Pick<NoteIdentity, "uid" | "error"> {
  try {
    let value: unknown;
    if (settings.uidSource === "filename") {
      if (!settings.uidFilenamePattern) { return { error: "Configure a filename UID pattern with one capture group." }; }
      value = new RegExp(settings.uidFilenamePattern).exec(path.split("/").pop()!.replace(/\.md$/i, ""))?.[1];
    } else {
      const yaml = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text)?.[1];
      if (yaml === undefined) { return {}; }
      const doc = parseDocument(yaml, { uniqueKeys: true });
      if (doc.errors.length) { return { error: "Invalid frontmatter; identity cannot be read." }; }
      const scalar = doc.get(settings.uidProperty, true);
      if (!scalar) { return {}; }
      if (!isScalar(scalar)) { return { error: "UID must be a string." }; }
      value = scalar.value;
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || !/^(0|[1-9]\d*)$/.test(scalar.source || "")) {
          return { error: "Quote the UID to preserve its exact value." };
        }
        value = scalar.source;
      }
    }
    if (value === undefined || value === null || value === "") { return {}; }
    return typeof value === "string" && validIdentity(value) ? { uid: value } : { error: "UID must be a nonempty, exact string." };
  } catch (error) { return { error: (error as Error).message }; }
}

/** Rebuildable path mapping. Duplicate UIDs are retained, never resolved by order. */
export class VaultIdentity {
  private notes = new Map<string, NoteIdentity>();
  constructor(readonly settings: () => IdentitySettings) {}
  update(path: string, content: string): void {
    this.notes.set(path, { path, title: path.split("/").pop()!.replace(/\.md$/i, ""), ...readDocumentUID(content, path, this.settings()) });
  }
  remove(path: string): void { this.notes.delete(path); }
  clear(): void { this.notes.clear(); }
  get(path: string): NoteIdentity | undefined { return this.notes.get(path); }
  resolve(vaultID: string, uid: string): { status: "found" | "missing" | "conflict" | "other-vault"; notes: NoteIdentity[] } {
    if (vaultID !== this.settings().vaultID) { return { status: "other-vault", notes: [] }; }
    const notes = [...this.notes.values()].filter((n) => n.uid === uid);
    return { status: notes.length === 1 ? "found" : notes.length ? "conflict" : "missing", notes };
  }
  /** The UIDs of every note except the one at `exceptPath`, for probing many candidates at once. */
  usedUIDs(exceptPath?: string): Set<string> {
    const used = new Set<string>();
    for (const n of this.notes.values()) { if (n.uid && n.path !== exceptPath) { used.add(n.uid); } }
    return used;
  }
  /** Stops at `limit`: the suggester calls this on every keystroke. */
  search(query: string, limit = 50): NoteIdentity[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean), result: NoteIdentity[] = [];
    if (limit <= 0) { return result; }
    for (const n of this.notes.values()) {
      if (terms.length) {
        const haystack = `${n.path} ${n.uid || ""}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) { continue; }
      }
      result.push(n);
      if (result.length >= limit) { break; }
    }
    return result;
  }
}

/** Local-time YYYYMMDDHHmmss, the common Zettelkasten UID form. */
export function timestampUID(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The first timestamp UID from `start`, a second at a time, that `taken` does not reject. */
export function uniqueTimestampUID(start: Date, taken: (uid: string) => boolean): string {
  for (let time = start.getTime(); ; time += 1000) {
    const uid = timestampUID(new Date(time));
    if (!taken(uid)) { return uid; }
  }
}
