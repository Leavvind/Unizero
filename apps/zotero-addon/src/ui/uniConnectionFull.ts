/**
 * UniConnection full: the References / Citations lists of one paper side by side in
 * their own window, with room to drag passages in from the reader
 * (docs/UNICONNECTION.md §5.3).
 *
 * The window document is an empty shell; the lists are the same LiteratureSidebar the
 * item pane uses, mounted in `full` layout. The window follows the paper of the main
 * window's current tab until the user pins it. One window at most; reopening it
 * for another paper reuses it.
 */

import { config } from "../../package.json";
import { libraryHit } from "../zotero/librarySearch";
import { t, type LiteratureSidebar } from "./literatureSidebar";
import { shortAuthors } from "./literatureSidebarModel";

const FULL_URL = `chrome://${config.addonRef}/content/uniconnection-full.xhtml`;
const FULL_NAME = `${config.addonRef}-uniconnection-full`;
const ROOT_ID = `${config.addonRef}-full`;
const XHTML = "http://www.w3.org/1999/xhtml";
const CLASS = "unizero-full";

interface FullUI {
  credit: HTMLElement;
  title: HTMLElement;
  pin: HTMLElement;
  body: HTMLElement;
}

function create(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const element = doc.createElementNS(XHTML, tag) as HTMLElement;
  element.className = className;
  if (text !== undefined) { element.textContent = text; }
  return element;
}

export class UniConnectionFull {
  private win: Window | null = null;
  private owner: Window | null = null;
  private item: Zotero.Item | null = null;
  private pinned = false;
  private ui?: FullUI;

  public constructor(
    private readonly sidebar: LiteratureSidebar,
    /** Adds the lists' stylesheet to a document. */
    private readonly addStyle: (doc: Document) => void,
    /** The paper of the owner window's current tab, which an unpinned window follows. */
    private readonly currentPaper: (owner: Window) => Zotero.Item | undefined,
  ) {}

  /** Show `item`, opening the window or bringing it forward. */
  public open(owner: Window, item: Zotero.Item): void {
    this.owner = owner;
    if (this.win && !this.win.closed) {
      this.show(item);
      this.win.focus();
      return;
    }
    this.item = item;
    this.pinned = false;
    this.win = (owner as any).openDialog(FULL_URL, FULL_NAME, "chrome,resizable=yes,dialog=no", {
      onLoad: (win: Window) => { if (this.win === win) { this.mount(win); } },
      onUnload: (win: Window) => this.forget(win),
    }) as Window;
  }

  /**
   * A main window's tab or selection changed. Only the window that opened full is
   * followed (unless pinned), and only its current tab: re-read from that window, so
   * changes in other windows or background panes cannot move it.
   */
  public ownerChanged(from?: Window): void {
    const owner = this.owner;
    if (!owner || owner.closed || (from && from !== owner)) { return; }
    this.follow(this.currentPaper(owner));
  }

  private follow(item: Zotero.Item | undefined): void {
    if (!item || this.pinned || !this.ui || !this.win || this.win.closed) { return; }
    if (this.item?.id === item.id) { return; }
    this.show(item);
  }

  public close(): void {
    const win = this.win;
    if (win && !win.closed) {
      try { win.close(); } catch { /* already closing */ }
    }
    if (win) { this.forget(win); }
  }

  public closeForOwner(owner: Window): void {
    if (this.owner === owner) { this.close(); }
  }

  private mount(win: Window): void {
    const doc = win.document;
    const root = doc.getElementById(ROOT_ID);
    if (!root) { return; }
    this.addStyle(doc);
    root.classList.add(CLASS);

    const header = create(doc, "div", `${CLASS}__header`);
    const heading = create(doc, "div", `${CLASS}__paper`);
    const credit = create(doc, "span", `${CLASS}__credit`);
    const title = create(doc, "span", `${CLASS}__title`);
    heading.append(credit, title);
    const pin = create(doc, "div", `unizero-sidebar__action ${CLASS}__pin`);
    pin.setAttribute("role", "button");
    pin.setAttribute("tabindex", "0");
    const toggle = (event: Event) => {
      event.preventDefault();
      this.setPinned(!this.pinned);
    };
    pin.addEventListener("click", toggle);
    pin.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { toggle(event); }
    });
    header.append(heading, pin);

    const body = create(doc, "div", `${CLASS}__body`);
    root.append(header, body);
    this.ui = { credit, title, pin, body };
    this.drawPin();
    if (this.item) { this.show(this.item); }
  }

  private show(item: Zotero.Item): void {
    this.item = item;
    const ui = this.ui;
    if (!ui) { return; }
    const summary = libraryHit(item);
    const credit = [shortAuthors(summary.authors), summary.year && `(${summary.year})`].filter(Boolean).join(" ");
    ui.credit.textContent = credit ? `${credit} ` : "";
    ui.title.textContent = summary.title || "Untitled";
    ui.title.title = summary.title;
    if (this.win) { this.win.document.title = `UniConnection — ${credit || summary.title}`; }
    this.sidebar.render(ui.body, item, "full");
  }

  private setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.drawPin();
    if (!pinned) { this.ownerChanged(); }
  }

  private drawPin(): void {
    const pin = this.ui?.pin;
    if (!pin) { return; }
    pin.textContent = this.pinned ? t("full-pinned", "📌 Pinned") : t("full-following", "Following current tab");
    pin.title = this.pinned
      ? t("full-unpin-hint", "Follow the paper of the current tab again")
      : t("full-pin-hint", "Keep showing this paper when you switch tabs");
    pin.classList.toggle("is-active", this.pinned);
    pin.setAttribute("aria-pressed", String(this.pinned));
  }

  private forget(win: Window): void {
    if (this.win !== win) { return; }
    if (this.ui) { this.sidebar.clear(this.ui.body); }
    this.win = null;
    this.owner = null;
    this.item = null;
    this.ui = undefined;
    this.pinned = false;
  }
}
