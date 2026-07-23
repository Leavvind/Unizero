/**
 * In-panel status bar.
 *
 * Every status message used to go through Zotero's ProgressWindow, stacking in the
 * bottom-right of the main window: the action happened in the sidebar while the
 * feedback appeared at the other end of the screen, forcing the eye back and
 * forth, and several at once covered the item list. Status messages now sit at the
 * top of the Reference section itself, just below the tab bar.
 *
 * The public API deliberately mirrors ProgressWindowHelper's chained calls
 * (createLine / changeLine / changeHeadline / show / startCloseTimer), so call
 * sites only swap the constructor. With no visible panel — in the library view
 * with the section collapsed, say — it falls back to ProgressWindow automatically,
 * because otherwise the message would be silently lost.
 */

const NS_XHTML = "http://www.w3.org/1999/xhtml";
const DEFAULT_CLOSE_TIME = 3000;

type StatusType = "default" | "success" | "fail" | string;

interface LineOptions {
  type?: StatusType;
  icon?: string;
  text?: string;
  progress?: number;
  idx?: number;
}

interface StatusOptions {
  window?: Window;
  closeOnClick?: boolean;
  closeTime?: number;
  closeOtherProgressWindows?: boolean;
}

/** Get the Reference section actually visible to the user right now. */
function findVisiblePanel(win?: Window): HTMLElement | undefined {
  const doc = (win ?? (Zotero as any).getMainWindow?.())?.document
    ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) { return; }
  const panels = [...doc.querySelectorAll(".zoference-section")] as HTMLElement[];
  // A null offsetParent means it lives in a hidden tab; the reader gives every tab
  // its own item pane.
  return panels.find((panel) => panel.isConnected && panel.offsetParent !== null)
    ?? panels.find((panel) => panel.isConnected);
}

function create(doc: Document, tag: string, className?: string): HTMLElement {
  const element = doc.createElementNS(NS_XHTML, tag) as HTMLElement;
  if (className) { element.className = className; }
  return element;
}

/**
 * The bar is created on demand: Zotero rebuilds the section repeatedly, so baking
 * it into the template would only make it easier to lose.
 */
function ensureBar(panel: HTMLElement): HTMLElement {
  let bar = panel.querySelector(".reference-status") as HTMLElement | null;
  if (bar) { return bar; }
  const doc = panel.ownerDocument;
  bar = create(doc, "div", "reference-status");
  bar.append(
    create(doc, "span", "reference-status-headline"),
    create(doc, "span", "reference-status-text"),
  );
  const progress = create(doc, "div", "reference-status-progress");
  progress.append(create(doc, "div", "reference-status-progress-bar"));
  bar.append(progress);
  const tabs = panel.querySelector(".reference-tabs");
  // Placed below the tab bar: both tabs share one bar, so switching tabs does not
  // make an in-progress message disappear.
  if (tabs) { tabs.after(bar); } else { panel.prepend(bar); }
  return bar;
}

/** The status bar currently on screen; backs closeOtherProgressWindows and displacement. */
let active: PanelStatus | undefined;

export class PanelStatus {
  private headline: string;
  private options: StatusOptions;
  private bar?: HTMLElement;
  private fallback?: any;
  private closeTimer?: number;
  private line: LineOptions = {};
  private shown = false;

  constructor(headline: string, options: StatusOptions = {}) {
    this.headline = headline;
    this.options = options;
  }

  createLine(options: LineOptions): this {
    this.line = { ...options };
    this.render();
    return this;
  }

  changeLine(options: LineOptions): this {
    this.line = { ...this.line, ...options };
    this.render();
    return this;
  }

  changeHeadline(text: string): this {
    this.headline = text;
    this.render();
    return this;
  }

  show(closeTime?: number): this {
    const panel = findVisiblePanel(this.options.window);
    if (!panel) {
      // With no visible panel, fall back to the old bottom-right popup — better
      // than showing nothing at all.
      this.fallback = new ztoolkit.ProgressWindow(this.headline, this.options);
      this.fallback.createLine(this.line).show(closeTime);
      return this;
    }
    this.shown = true;
    this.claim(panel);
    const timeout = closeTime ?? this.options.closeTime ?? DEFAULT_CLOSE_TIME;
    // closeTime <= 0 is the "I will close it myself" convention used by long
    // tasks, carried over from ProgressWindow's semantics.
    if (timeout > 0) { this.startCloseTimer(timeout); }
    return this;
  }

  startCloseTimer(closeTime: number = DEFAULT_CLOSE_TIME): this {
    if (this.fallback) {
      this.fallback.startCloseTimer(closeTime);
      return this;
    }
    this.clearTimer();
    const win = this.bar?.ownerDocument?.defaultView;
    if (!win) { return this; }
    this.closeTimer = win.setTimeout(() => this.close(), closeTime);
    return this;
  }

  /** Displaced by another message: give up the bar but stay alive. */
  private displace(): void {
    this.clearTimer();
    if (active === this) { active = undefined; }
    this.bar = undefined;
  }

  close(): void {
    this.shown = false;
    this.clearTimer();
    if (this.fallback) {
      this.fallback.close?.();
      this.fallback = undefined;
      return;
    }
    if (active === this) { active = undefined; }
    // Only tear down while the bar still shows our own content, so we never close
    // a message someone else just wrote.
    if (this.bar && (this.bar as any)._owner === this) {
      this.bar.remove();
    }
    this.bar = undefined;
  }

  private clearTimer() {
    if (this.closeTimer === undefined) { return; }
    this.bar?.ownerDocument?.defaultView?.clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  /** Take over the current panel's status bar, displacing the previous message. */
  private claim(panel: HTMLElement) {
    // Displace rather than close: if the other message belongs to a long task
    // still running, its later updates can reclaim the bar.
    if (active && active !== this) { active.displace(); }
    active = this;
    this.bar = ensureBar(panel);
    this.render();
  }

  private render() {
    // Once Zotero rebuilds the section — on item switch or list refresh — the old
    // bar is gone; a long task's later changeLine calls must be able to reattach,
    // or "in progress" goes silent partway and no result is ever shown.
    if (this.shown && !this.fallback && !this.bar?.isConnected) {
      const panel = findVisiblePanel(this.options.window);
      if (panel) { this.claim(panel); return; }
    }
    const bar = this.bar;
    if (!bar || !bar.isConnected) { return; }
    (bar as any)._owner = this;
    const type = this.line.type || "default";
    bar.dataset.type = type;
    (bar.querySelector(".reference-status-headline") as HTMLElement).textContent =
      this.headline;
    (bar.querySelector(".reference-status-text") as HTMLElement).textContent =
      this.line.text || "";
    const progress = bar.querySelector(".reference-status-progress") as HTMLElement;
    const value = this.line.progress;
    progress.style.display = typeof value === "number" ? "block" : "none";
    if (typeof value === "number") {
      (progress.firstElementChild as HTMLElement).style.width =
        `${Math.max(0, Math.min(100, value))}%`;
    }
  }
}

/**
 * Create an in-panel status message. Called exactly like
 * `new ztoolkit.ProgressWindow(...)`.
 */
export function status(headline: string, options: StatusOptions = {}): PanelStatus {
  return new PanelStatus(headline, options);
}

/** Dismiss the current status bar; the counterpart of `Zotero.ProgressWindowSet.closeAll()`. */
export function closeStatus() {
  active?.close();
}
