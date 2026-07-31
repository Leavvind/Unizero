/**
 * Shared, deduplicated cache of resolved papers.
 *
 * A page can hold dozens of `@citekey` pills and every one of them needs the same
 * few fields. Without a store in between, each pill would issue its own request,
 * each re-render would issue them again, and a canvas full of cards would put
 * hundreds of round trips through Zotero's single-threaded server. So:
 *
 * - one entry per citekey, shared by every pill that names it;
 * - one in-flight request per citekey, awaited by every later caller;
 * - a synchronous `peek` so a pill can render its final shape immediately when the
 *   paper is already known, and only fall back to a placeholder when it is not.
 *
 * Entries are kept until something invalidates them. Zotero metadata does not
 * change often, and a stale title is a far smaller problem than a request storm.
 */

import { BridgeError, type BridgePaper, type UnizeroBridge } from "./bridge";

export type PaperState =
  | { status: "loading" }
  | { status: "ready"; paper: BridgePaper }
  | { status: "missing" }
  | { status: "error"; message: string };

type Listener = (state: PaperState) => void;

interface Entry {
  state: PaperState;
  /** Present only while a request is in flight; later callers await this one. */
  pending?: Promise<PaperState>;
  listeners: Set<Listener>;
}

export class PaperStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly bridge: UnizeroBridge) {}

  /** What is known right now, without starting a request. */
  peek(citekey: string): PaperState | undefined {
    return this.entries.get(citekey)?.state;
  }

  private entry(citekey: string): Entry {
    let entry = this.entries.get(citekey);
    if (!entry) {
      entry = { state: { status: "loading" }, listeners: new Set() };
      this.entries.set(citekey, entry);
    }
    return entry;
  }

  private publish(citekey: string, state: PaperState): PaperState {
    const entry = this.entry(citekey);
    entry.state = state;
    for (const listener of [...entry.listeners]) {
      try {
        listener(state);
      } catch (error) {
        // One detached pill must not stop the others from updating.
        console.error("UniZero: paper listener failed", error);
      }
    }
    return state;
  }

  /**
   * Resolve a citekey, reusing an in-flight or completed request.
   *
   * A previous failure is retried, because the usual cause is Zotero not running
   * yet; a previous 404 is not, because the add-on already searched every library.
   */
  load(citekey: string): Promise<PaperState> {
    const entry = this.entry(citekey);
    if (entry.state.status === "ready" || entry.state.status === "missing") {
      return Promise.resolve(entry.state);
    }
    if (entry.pending) { return entry.pending; }

    const pending = this.bridge.paper(citekey)
      .then((paper) => this.publish(citekey, { status: "ready", paper }))
      .catch((error: unknown) => {
        if (error instanceof BridgeError && error.status === 404) {
          return this.publish(citekey, { status: "missing" });
        }
        return this.publish(citekey, {
          status: "error",
          message: (error as Error)?.message || "could not reach Zotero",
        });
      })
      .finally(() => {
        const current = this.entries.get(citekey);
        // An invalidate during the request may already have replaced or dropped
        // the entry; only the request that still owns it may clear the slot.
        if (current?.pending === pending) { delete current.pending; }
      });

    entry.pending = pending;
    return pending;
  }

  /**
   * Watch one citekey.
   *
   * Subscribing starts the load, so a pill's only job is to render whatever state
   * it is handed. The returned function must be called when the pill goes away —
   * a canvas creates and destroys these constantly while panning.
   */
  subscribe(citekey: string, listener: Listener): () => void {
    const entry = this.entry(citekey);
    entry.listeners.add(listener);
    listener(entry.state);
    void this.load(citekey);

    return () => {
      const current = this.entries.get(citekey);
      current?.listeners.delete(listener);
    };
  }

  /**
   * Drop cached papers and tell every live pill to re-resolve.
   *
   * Used when the endpoint setting changes or the user asks for a refresh. Errors
   * and misses are cleared along with successes: both can be caused by a Zotero
   * that was not running, and both should be reconsidered once it is.
   */
  invalidate(): void {
    for (const citekey of [...this.entries.keys()]) {
      const entry = this.entries.get(citekey)!;
      if (!entry.listeners.size) {
        this.entries.delete(citekey);
        continue;
      }
      delete entry.pending;
      this.publish(citekey, { status: "loading" });
      void this.load(citekey);
    }
  }
}
