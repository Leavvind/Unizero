/**
 * The inline citation syntax.
 *
 * Forms share one prefix — identity is Zotero's durable pair:
 *
 *   @libraryID/itemKey           the paper itself — opens the detail pane
 *   @libraryID/itemKey.md        the converted Raw Markdown
 *   @libraryID/itemKey.pdf       the PDF, opened in Zotero
 *   @libraryID/itemKey.pdf:15    the PDF at physical page 15 (Zotero `?page=`)
 *
 * What the user *types* at the `@` prompt is free text (author, title, year).
 * What gets *written* into the note is always `libraryID/itemKey`, because the
 * pill already shows Author (year) / title and the source token only has to be
 * stable. A citekey is still returned by the bridge as metadata; it is not the
 * link.
 *
 * The module is deliberately free of Obsidian imports. Both renderers — the
 * reading-mode post-processor and the live-preview CodeMirror extension — have to
 * agree on exactly which spans are citations, and the only way to guarantee that
 * is for both to call the same scanner.
 */

export type CitationAction = "detail" | "markdown" | "pdf";

/** Durable pointer to one Zotero item. */
export interface PaperRef {
  libraryID: number;
  itemKey: string;
}

export interface CitationToken extends PaperRef {
  /** The matched text, including the `@` and any suffix. */
  raw: string;
  action: CitationAction;
  /**
   * 1-based PDF physical page for `.pdf:{page}` only.
   * Passed to Zotero as `?page=N`; not a printed page label.
   */
  page?: number;
  /** Offsets into the scanned string; `to` is exclusive. */
  from: number;
  to: number;
}

/**
 * Zotero item keys are short alphanumeric tokens. Library IDs are integers.
 * Excluding `.` from the key keeps `.md` / `.pdf` unambiguous.
 * Page is only valid after `.pdf:` and must be a positive integer.
 */
const TOKEN = /@(\d+)\/([A-Za-z0-9]+)(\.md|\.pdf(?::([1-9]\d*))?)?/g;

/**
 * Characters that cancel a match when they immediately precede the `@`.
 *
 * Word characters keep `user@example.com` from citing; a second `@` keeps
 * `@@…` from matching its tail; `/` and `.` cover paths and hostnames; `\` is
 * the escape — `\@notacitation` renders as written.
 */
const CANCELLING_PREFIX = /[A-Za-z0-9_@/\\.]/;

/**
 * Characters that end a free-text `@` search so the popup does not follow the
 * caret through the rest of a sentence after a finished citation.
 *
 * Spaces are deliberately *not* terminators: multi-word search is the point.
 * Period is allowed so titles and initials survive; a period followed by a
 * space still ends the span — that is ordinary prose after a citation.
 */
const SEARCH_HARD_TERMINATOR = /[,;!?)\]]|[，；、！？）】]|\.\s/;

function actionFor(suffix: string | undefined): CitationAction {
  if (suffix === ".md") { return "markdown"; }
  if (suffix?.startsWith(".pdf")) { return "pdf"; }
  return "detail";
}

function pageFor(pageText: string | undefined): number | undefined {
  if (!pageText) { return undefined; }
  const page = Number(pageText);
  return Number.isInteger(page) && page > 0 ? page : undefined;
}

/** Canonical map key / display fragment: `1/ABCD1234`. */
export function paperRefKey(ref: PaperRef): string {
  return `${ref.libraryID}/${ref.itemKey}`;
}

export function isPaperRef(value: unknown): value is PaperRef {
  if (!value || typeof value !== "object") { return false; }
  const ref = value as PaperRef;
  return Number.isInteger(ref.libraryID) &&
    ref.libraryID > 0 &&
    typeof ref.itemKey === "string" &&
    /^[A-Za-z0-9]+$/.test(ref.itemKey);
}

/** Every citation in `text`, in order. */
export function scanCitations(text: string): CitationToken[] {
  const tokens: CitationToken[] = [];
  TOKEN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const from = match.index;
    if (from > 0 && CANCELLING_PREFIX.test(text.charAt(from - 1))) { continue; }
    const action = actionFor(match[3]);
    const page = action === "pdf" ? pageFor(match[4]) : undefined;
    tokens.push({
      raw: match[0],
      libraryID: Number(match[1]),
      itemKey: match[2],
      action,
      ...(page !== undefined ? { page } : {}),
      from,
      to: from + match[0].length,
    });
  }
  return tokens;
}

/**
 * The free-text query being typed immediately before `cursor`, for `@` completion.
 *
 * Spaces are allowed (`@richardson accounting`). Selecting a hit always inserts
 * `@libraryID/itemKey` (or with `.md` / `.pdf`).
 *
 * Returns undefined once the prefix stops looking like a search, so the
 * suggester closes instead of following the caret across unrelated text.
 */
export function citationPrefixAt(
  line: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const before = line.slice(0, cursor);
  const match = before.match(/@([^@\n]*)$/);
  if (!match) { return; }

  const start = before.length - match[0].length;
  if (start > 0 && CANCELLING_PREFIX.test(line.charAt(start - 1))) { return; }

  const raw = match[1];
  // A completed written citation (with or without action suffix) is not a search.
  if (/^\d+\/[A-Za-z0-9]+(\.md|\.pdf(?::[1-9]\d*)?)?$/i.test(raw)) { return; }
  if (/\.(md|pdf)(?::[1-9]\d*)?$/i.test(raw)) { return; }
  if (SEARCH_HARD_TERMINATOR.test(raw)) { return; }

  const query = raw.replace(/\s+/g, " ").trim();
  return { start, query };
}

/** The text a completion inserts. Optional `page` applies only to the PDF action. */
export function citationText(
  ref: PaperRef,
  action: CitationAction = "detail",
  page?: number,
): string {
  if (action === "markdown") { return `@${paperRefKey(ref)}.md`; }
  if (action === "pdf") {
    const pageSuffix = page && page > 0 ? `:${page}` : "";
    return `@${paperRefKey(ref)}.pdf${pageSuffix}`;
  }
  return `@${paperRefKey(ref)}`;
}

/** Append `?page=N` (or `&page=N`) for a positive physical PDF page. */
export function withPdfPage(zoteroPdfUrl: string, page?: number): string {
  if (!page || page < 1 || !Number.isInteger(page)) { return zoteroPdfUrl; }
  const sep = zoteroPdfUrl.includes("?") ? "&" : "?";
  return `${zoteroPdfUrl}${sep}page=${page}`;
}

/** Custom MIME for internal drags; editors also receive `text/plain`. */
export const CITATION_DRAG_MIME = "application/x-unizero-citation";

/**
 * Populate a drag payload so dropping on a Markdown editor inserts the citation.
 * Obsidian's editor accepts `text/plain` natively.
 */
export function setCitationDragData(
  dataTransfer: DataTransfer,
  ref: PaperRef,
  action: CitationAction = "detail",
): void {
  const text = citationText(ref, action);
  dataTransfer.setData("text/plain", text);
  dataTransfer.setData(CITATION_DRAG_MIME, text);
  dataTransfer.effectAllowed = "copy";
}

/**
 * Wire an element so it can be dragged into a note as `@libraryID/itemKey`.
 * Uses plain DOM APIs so this module stays free of Obsidian imports.
 */
export function enableCitationDrag(
  element: HTMLElement,
  ref: PaperRef,
  action: CitationAction = "detail",
): void {
  element.draggable = true;
  element.classList.add("unizero-draggable");
  element.addEventListener("dragstart", (event) => {
    if (!event.dataTransfer) { return; }
    setCitationDragData(event.dataTransfer, ref, action);
    element.classList.add("is-dragging");
  });
  element.addEventListener("dragend", () => {
    element.classList.remove("is-dragging");
  });
}
