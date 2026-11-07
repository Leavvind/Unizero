import workerSource from "unizero:link-worker";
import { mayContainDocumentLinks, scanCanvasLinks, scanDocumentLinks, type DocumentLink } from "./documentLinks";

type Format = "md" | "canvas";
type Job = { text: string; format: Format; current: () => boolean;
  resolve: (links: DocumentLink[] | undefined) => void; reject: (error: Error) => void };

/** One worker, one in-flight parse; obsolete queued documents are never parsed. */
export class DocumentScanner {
  private worker?: Worker;
  private active?: Job;
  private queue: Job[] = [];
  private stopped = false;
  private unavailable = false;

  scan(text: string, format: Format, current: () => boolean): Promise<DocumentLink[] | undefined> {
    if (this.stopped || !current()) { return Promise.resolve(undefined); }
    if (format === "md" && !mayContainDocumentLinks(text)) { return Promise.resolve([]); }
    // Small notes avoid worker messaging overhead. Large ones retain the exact
    // same parser, including document-wide definitions, code and comments.
    if (text.length < 32_768 || this.unavailable || typeof Worker === "undefined") {
      return Promise.resolve(format === "canvas" ? scanCanvasLinks(text) : scanDocumentLinks(text));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ text, format, current, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.stopped) { return; }
    let job: Job | undefined;
    while ((job = this.queue.shift())) {
      if (job.current()) { break; }
      job.resolve(undefined);
    }
    if (!job) { return; }
    this.active = job;
    try {
      if (!this.worker) {
        const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        try { this.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        this.worker.onmessage = (event: MessageEvent<{ links?: DocumentLink[]; error?: string }>) => {
          const active = this.active;
          this.active = undefined;
          if (event.data.error) { active?.reject(new Error(event.data.error)); }
          else { active?.resolve(event.data.links); }
          this.pump();
        };
        this.worker.onerror = (event) => this.fail(new Error(event.message || "Document parser worker failed"));
      }
      this.worker.postMessage({ text: job.text, format: job.format });
    } catch (error) { this.fail(error as Error); }
  }

  private fail(error: Error): void {
    // The worker is gone for good; parse its pending documents with the ordinary parser.
    console.error("UniZero document parser worker", error);
    this.unavailable = true;
    this.worker?.terminate();
    this.worker = undefined;
    const jobs = [...(this.active ? [this.active] : []), ...this.queue.splice(0)];
    this.active = undefined;
    for (const job of jobs) {
      if (!job.current()) { job.resolve(undefined); continue; }
      try { job.resolve(job.format === "canvas" ? scanCanvasLinks(job.text) : scanDocumentLinks(job.text)); }
      catch (parseError) { job.reject(parseError as Error); }
    }
  }

  dispose(): void {
    this.stopped = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.active?.resolve(undefined);
    this.active = undefined;
    for (const job of this.queue.splice(0)) { job.resolve(undefined); }
  }
}
