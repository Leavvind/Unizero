import type { BridgeCollectionItem } from "./bridge";

/** Fixed-height rows keep DOM work proportional to the viewport, not the collection. */
export class LibraryRows {
  private readonly spacer: HTMLDivElement;
  private readonly rows = new Map<number, HTMLElement>();
  private readonly window: Window;
  private observer?: ResizeObserver;
  private frame?: number;
  private rowHeight = 105;
  private disposed = false;

  constructor(private readonly host: HTMLElement, private readonly items: BridgeCollectionItem[],
    private readonly renderRow: (parent: HTMLElement, item: BridgeCollectionItem) => HTMLElement,
    scrollTop: number) {
    this.window = host.ownerDocument.defaultView!;
    this.spacer = host.ownerDocument.createElement("div");
    this.spacer.className = "unizero-library__rows";
    host.append(this.spacer);
    host.addEventListener("scroll", this.schedule);
    host.addEventListener("keydown", this.onKeyDown);
    host.addEventListener("focusout", this.schedule);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.schedule);
      this.observer.observe(host);
    }
    this.measure();
    host.scrollTop = Math.min(scrollTop, Math.max(0, items.length * this.rowHeight - host.clientHeight));
    this.render();
  }

  private measure(): void {
    // em-based sizing follows the host's UI font and zoom. The title remains
    // clamped to two lines, with reserved space for metadata and artifact badges.
    this.rowHeight = Math.ceil((parseFloat(this.window.getComputedStyle(this.host).fontSize) || 14) * 7.5);
    this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
  }

  private schedule = (): void => {
    if (this.disposed || this.frame !== undefined) { return; }
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = undefined;
      this.measure();
      this.render();
    });
  };

  private render(): void {
    const start = Math.max(0, Math.floor(this.host.scrollTop / this.rowHeight) - 4);
    const end = Math.min(this.items.length, Math.ceil((this.host.scrollTop + this.host.clientHeight) / this.rowHeight) + 4);
    const focused = this.host.ownerDocument.activeElement;
    for (const [index, row] of this.rows) {
      if ((index < start || index >= end) && !row.contains(focused)) { row.remove(); this.rows.delete(index); }
    }
    for (let index = start; index < end; index++) {
      if (!this.rows.has(index)) {
        const row = this.renderRow(this.spacer, this.items[index]);
        row.dataset.rowIndex = String(index);
        const next = [...this.rows].filter(([other]) => other > index).sort((a, b) => a[0] - b[0])[0]?.[1];
        if (next) { this.spacer.insertBefore(row, next); }
        this.rows.set(index, row);
      }
    }
    // Existing rows are never reparented, so scrolling preserves their focus.
    for (const [index, row] of this.rows) {
      row.style.top = `${index * this.rowHeight}px`;
      row.style.height = `${this.rowHeight}px`;
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const element = event.target as HTMLElement;
    const row = element.closest<HTMLElement>("[data-row-index]");
    if (!row || event.altKey || event.ctrlKey || event.metaKey) { return; }
    const index = Number(row.dataset.rowIndex);
    const page = Math.max(1, Math.floor(this.host.clientHeight / this.rowHeight));
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1
      : event.key === "PageDown" ? index + page : event.key === "PageUp" ? index - page
      : event.key === "Home" ? 0 : event.key === "End" ? this.items.length - 1 : undefined;
    if (target === undefined) { return; }
    event.preventDefault();
    const bounded = Math.max(0, Math.min(this.items.length - 1, target));
    const top = bounded * this.rowHeight;
    if (top < this.host.scrollTop) { this.host.scrollTop = top; }
    else if (top + this.rowHeight > this.host.scrollTop + this.host.clientHeight) {
      this.host.scrollTop = top + this.rowHeight - this.host.clientHeight;
    }
    this.render();
    this.rows.get(bounded)?.focus({ preventScroll: true });
  };

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    if (this.frame !== undefined) { this.window.cancelAnimationFrame(this.frame); }
    this.host.removeEventListener("scroll", this.schedule);
    this.host.removeEventListener("keydown", this.onKeyDown);
    this.host.removeEventListener("focusout", this.schedule);
    this.rows.clear();
  }
}
