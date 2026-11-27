/**
 * Reads papers' Raw and Canvas attachments into the paper-link index
 * (docs/UNICONNECTION.md §3).
 *
 * Obsidian edits these files without Zotero hearing of it, so the index is refreshed
 * when Uniconnection opens or reloads: every Raw and Canvas is listed through the
 * same read-only discovery as the bridge, its size and modification time are
 * checked, and only a file whose fingerprint changed is read and parsed again.
 * Read-only: nothing is written to an attachment, a note, or the cache.
 */

import { isPaperNotePurpose, scanCanvasLinks, scanDocumentLinks } from "@unizero/links";
import { PaperLinkIndex, sourceKey, type PaperNote } from "../modules/paperLinkIndex";
import { linkSourceLibraries, listLinkSources, type LinkSource } from "./linkSources";

/** Files parsed between two yields to the event loop. */
const READS_PER_SLICE = 8;

export interface PaperLinkRefresh {
  /** Raw and Canvas attachments found. */
  sources: number;
  /** Of those, how many were read and parsed this time (the rest were unchanged). */
  read: number;
  /** Attachments whose file is not on this computer. */
  unavailable: number;
  /** Attachments that could not be read or parsed. */
  failed: number;
}

function paperNote(source: LinkSource): PaperNote | undefined {
  if (!isPaperNotePurpose(source.purpose)) { return; }
  return {
    libraryID: source.libraryID,
    itemKey: source.itemKey,
    attachmentKey: source.attachmentKey,
    purpose: source.purpose,
    title: source.title,
  };
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class PaperLinks {
  public readonly index = new PaperLinkIndex();
  private running?: Promise<PaperLinkRefresh>;
  private generation = 0;

  /** Bring the index up to date with the files. Concurrent callers share one pass. */
  public refresh(): Promise<PaperLinkRefresh> {
    if (!this.running) {
      const generation = this.generation;
      const running = this.run(generation).finally(() => {
        if (this.running === running) { this.running = undefined; }
      });
      this.running = running;
    }
    return this.running;
  }

  /** Forget everything; the next refresh reads every file again. */
  public clear(): void {
    this.generation += 1;
    this.running = undefined;
    this.index.clear();
  }

  private async run(generation: number): Promise<PaperLinkRefresh> {
    const listed = await listLinkSources(linkSourceLibraries());
    const report: PaperLinkRefresh = { sources: 0, read: 0, unavailable: 0, failed: 0 };
    const keep = new Set<string>();
    for (const source of listed) {
      const note = paperNote(source);
      if (!note) { continue; }
      if (generation !== this.generation) { return report; }
      report.sources += 1;
      if (!source.available || !source.path) {
        // Its links are unknown here; it is not listed, so it holds none.
        report.unavailable += 1;
        continue;
      }
      keep.add(sourceKey(note));
      let fingerprint: string;
      let time: number | undefined;
      try {
        const stat = await IOUtils.stat(source.path);
        time = Number(stat.lastModified) || undefined;
        fingerprint = `${source.version}|${stat.size}|${stat.lastModified}`;
      } catch (error) {
        this.index.fail(note, String((error as Error)?.message || error));
        continue;
      }
      if (this.index.fingerprint(note) === fingerprint) { continue; }
      try {
        const text = String(await IOUtils.readUTF8(source.path));
        if (generation !== this.generation) { return report; }
        const links = source.format === "canvas" ? scanCanvasLinks(text) : scanDocumentLinks(text);
        this.index.put(note, fingerprint, links, time);
      } catch (error) {
        this.index.fail(note, String((error as Error)?.message || error));
      }
      report.read += 1;
      if (report.read % READS_PER_SLICE === 0) { await pause(); }
    }
    if (generation !== this.generation) { return report; }
    this.index.retain(keep);
    report.failed = this.index.failures().length;
    return report;
  }
}

/** One index for every window; memory only, cleared when the add-on shuts down. */
export const paperLinks = new PaperLinks();
