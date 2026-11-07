import { excludedSpans, findMentions, type Mention } from "./unlinkedMentions";
import { timeSlicer } from "./linkIndex";

export const MENTION_CONCURRENCY = 4;
const TERM_SETS = 8;
interface MentionSource { path: string; stat: { mtime: number; size: number } }
interface Entry { stamp: string; spans?: Array<[number, number]>; byTerms: Map<string, Mention[]> }
export interface MentionGroup { path: string; mentions: Mention[] }
const stampOf = (source: MentionSource) => `${source.stat.mtime}:${source.stat.size}`;

/** Bounded across overlapping scans; only unchanged source versions share reads. */
export class MentionScanner {
  private readonly cache = new Map<string, Entry>();
  private readonly reading = new Map<string, Promise<string>>();
  private generation = 0;

  clear(): void { this.generation++; this.cache.clear(); }

  private async read<T extends MentionSource>(source: T, path: string, stamp: string,
    read: (source: T) => Promise<string>, current: () => boolean): Promise<string | undefined> {
    const key = JSON.stringify([path, stamp]);
    while (current()) {
      const shared = this.reading.get(key);
      if (shared) { return shared; }
      if (this.reading.size < MENTION_CONCURRENCY) {
        const pending = Promise.resolve().then(() => read(source)).finally(() => { this.reading.delete(key); });
        this.reading.set(key, pending);
        return pending;
      }
      await Promise.race([...this.reading.values()].map((pending) => pending.catch(() => undefined)));
    }
    return undefined;
  }

  async scan<T extends MentionSource>(sources: T[], terms: string[], read: (source: T) => Promise<string>,
    isCurrent: () => boolean): Promise<MentionGroup[]> {
    const generation = this.generation, current = () => generation === this.generation && isCurrent();
    if (!current()) { return []; }
    const live = new Set(sources.map((source) => source.path));
    for (const path of this.cache.keys()) { if (!live.has(path)) { this.cache.delete(path); } }
    const key = JSON.stringify(terms), found: MentionGroup[] = [], slice = timeSlicer();
    for (let offset = 0; offset < sources.length && current(); offset += MENTION_CONCURRENCY) {
      await Promise.all(sources.slice(offset, offset + MENTION_CONCURRENCY).map(async (source) => {
        if (!current()) { return; }
        const path = source.path, stamp = stampOf(source);
        let entry = this.cache.get(path);
        if (entry?.stamp !== stamp) { entry = { stamp, byTerms: new Map() }; this.cache.set(path, entry); }
        let mentions = entry.byTerms.get(key);
        if (!mentions) {
          const text = await this.read(source, path, stamp, read, current);
          // A superseded read must neither scan nor fill the cache for a newer file version.
          if (text === undefined || !current() || source.path !== path || stampOf(source) !== stamp
            || this.cache.get(path) !== entry) { return; }
          const saved = entry;
          mentions = saved.byTerms.get(key) ?? findMentions(text, terms, () => saved.spans ??= excludedSpans(text));
          if (saved.byTerms.size >= TERM_SETS) { saved.byTerms.delete(saved.byTerms.keys().next().value!); }
          saved.byTerms.set(key, mentions);
        }
        if (mentions.length) { found.push({ path, mentions }); }
      }));
      // Even a warm cache yields between batches, so note switches and closing can cancel it.
      if (current() && offset + MENTION_CONCURRENCY < sources.length) {
        await slice();
      }
    }
    return current() ? found.sort((a, b) => a.path.localeCompare(b.path)) : [];
  }
}
