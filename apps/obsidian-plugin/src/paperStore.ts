/**
 * Shared, deduplicated cache of resolved papers.
 *
 * A page can hold dozens of citation pills and every one of them needs the same
 * few fields. Without a store in between, each pill would issue its own request,
 * each re-render would issue them again, and a board full of cards would put
 * hundreds of round trips through Zotero's single-threaded server. So:
 *
 * - one entry per `libraryID/itemKey`, shared by every pill that names it;
 * - one in-flight request per ref, awaited by every later caller;
 * - a synchronous `peek` so a pill can render its final shape immediately when the
 *   paper is already known, and only fall back to a placeholder when it is not.
 *
 * Entries are kept until something invalidates them. Zotero metadata does not
 * change often, and a stale title is a far smaller problem than a request storm.
 */

import { paperRefKey, type PaperRef } from "./citation";
import { BridgeError, type BridgePaper, type UnizeroBridge } from "./bridge";

export type PaperState =
  | { status: "loading" }
  | { status: "ready"; paper: BridgePaper }
  | { status: "missing" }
  | { status: "error"; message: string };

type Listener = (state: PaperState) => void;

interface Entry {
  ref: PaperRef;
  state: PaperState;
  /** Present only while a request is in flight; later callers await this one. */
  pending?: Promise<PaperState>;
  listeners: Set<Listener>;
}

export class PaperStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly bridge: UnizeroBridge) {}

  /** What is known right now, without starting a request. */
  peek(ref: PaperRef): PaperState | undefined {
    return this.entries.get(paperRefKey(ref))?.state;
  }

  private entry(ref: PaperRef): Entry {
    const key = paperRefKey(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        ref: { libraryID: ref.libraryID, itemKey: ref.itemKey },
        state: { status: "loading" },
        listeners: new Set(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private publish(ref: PaperRef, state: PaperState): PaperState {
    const entry = this.entry(ref);
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
   * Resolve a paper ref, reusing an in-flight or completed request.
   *
   * A previous failure is retried, because the usual cause is Zotero not running
   * yet; a previous 404 is not, because the add-on already looked the item up.
   */
  load(ref: PaperRef): Promise<PaperState> {
    const key = paperRefKey(ref);
    const entry = this.entry(ref);
    if (entry.state.status === "ready" || entry.state.status === "missing") {
      return Promise.resolve(entry.state);
    }
    if (entry.pending) { return entry.pending; }

    const pending = this.bridge.paper(ref)
      .then((paper) => this.publish(ref, { status: "ready", paper }))
      .catch((error: unknown) => {
        if (error instanceof BridgeError && error.status === 404) {
          return this.publish(ref, { status: "missing" });
        }
        return this.publish(ref, {
          status: "error",
          message: (error as Error)?.message || "could not reach Zotero",
        });
      })
      .finally(() => {
        const current = this.entries.get(key);
        // An invalidate during the request may already have replaced or dropped
        // the entry; only the request that still owns it may clear the slot.
        if (current?.pending === pending) { delete current.pending; }
      });

    entry.pending = pending;
    return pending;
  }

  /**
   * Watch one paper.
   *
   * Subscribing starts the load, so a pill's only job is to render whatever state
   * it is handed. The returned function must be called when the pill goes away.
   */
  subscribe(ref: PaperRef, listener: Listener): () => void {
    const key = paperRefKey(ref);
    const entry = this.entry(ref);
    entry.listeners.add(listener);
    listener(entry.state);
    void this.load(ref);

    return () => {
      const current = this.entries.get(key);
      current?.listeners.delete(listener);
    };
  }

  /** Repaint every live pill from cached state without touching the bridge. */
  refresh(): void {
    for (const entry of this.entries.values()) {
      for (const listener of [...entry.listeners]) {
        try {
          listener(entry.state);
        } catch (error) {
          console.error("UniZero: paper listener failed", error);
        }
      }
    }
  }

  /**
   * Drop cached papers and tell every live pill to re-resolve.
   *
   * Used when the endpoint setting changes or the user asks for a refresh. Errors
   * and misses are cleared along with successes: both can be caused by a Zotero
   * that was not running, and both should be reconsidered once it is.
   */
  invalidate(): void {
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key)!;
      if (!entry.listeners.size) {
        this.entries.delete(key);
        continue;
      }
      delete entry.pending;
      this.publish(entry.ref, { status: "loading" });
      void this.load(entry.ref);
    }
  }
}
