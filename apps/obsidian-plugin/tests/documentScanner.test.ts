import { afterEach, describe, expect, it, vi } from "vitest";
import { Worker as Thread } from "node:worker_threads";
import workerSource from "unizero:link-worker";
import { DocumentScanner } from "../src/documentScanner";
import { scanDocumentLinks } from "../src/documentLinks";

const scanners: DocumentScanner[] = [];
let messages = 0;
class BrowserWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  private thread = new Thread(`const { parentPort } = require('node:worker_threads');
    const self = { postMessage: (data) => parentPort.postMessage(data) };
    ${workerSource}
    parentPort.on('message', (data) => self.onmessage({ data }));`, { eval: true });
  constructor() {
    this.thread.on("message", (data) => this.onmessage?.({ data }));
    this.thread.on("error", (error) => this.onerror?.(error));
  }
  postMessage(data: unknown) { messages++; this.thread.postMessage(data); }
  terminate() { void this.thread.terminate(); }
}
function scanner() {
  vi.stubGlobal("Worker", BrowserWorker);
  const scanner = new DocumentScanner(); scanners.push(scanner); messages = 0;
  return scanner;
}
afterEach(() => { scanners.splice(0).forEach((s) => s.dispose()); vi.unstubAllGlobals(); });

describe("background document parsing", () => {
  const text = `${"ordinary text\n\n".repeat(14000)}[paper][ref]\n\n[ref]: unizero://paper/1/KEY\n`;
  it("skips the parser for a large ordinary note", async () => {
    expect(await scanner().scan("ordinary text\n".repeat(16000), "md", () => true)).toEqual([]);
    expect(messages).toBe(0);
  });
  it("uses the same complete-document semantics in a worker", async () => {
    const result = await scanner().scan(text, "md", () => true);
    expect(result).toEqual(scanDocumentLinks(text));
    expect(messages).toBe(1);
  });
  it("skips obsolete queued work and settles pending requests on disposal", async () => {
    const s = scanner();
    const first = s.scan(text, "md", () => true);
    let current = true;
    const obsolete = s.scan(text, "md", () => current);
    current = false;
    await first;
    expect(await obsolete).toBeUndefined();
    expect(messages).toBe(1);
    const active = s.scan(text, "md", () => true);
    const queued = s.scan(text, "md", () => true);
    s.dispose();
    expect(await active).toBeUndefined();
    expect(await queued).toBeUndefined();
  });
  it("reports invalid Canvas input and continues with later documents", async () => {
    const s = scanner();
    await expect(s.scan("{".repeat(40000), "canvas", () => true)).rejects.toThrow();
    expect(await s.scan(text, "md", () => true)).toHaveLength(1);
  });
});
