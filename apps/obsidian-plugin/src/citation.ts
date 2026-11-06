/**
 * Paper references and the `@` search trigger.
 *
 * Identity is Zotero's durable pair `libraryID/itemKey`. Notes store standard
 * Markdown links serialized by linkTarget.ts; documentLinks.ts scans them. Typing
 * `@` followed by free text opens the search that inserts such a link.
 */

import { markdownLink, paperLabel } from "./linkTarget";
export type CitationAction = "detail" | "markdown" | "pdf";

/** Durable pointer to one Zotero item. */
export interface PaperRef {
  libraryID: number;
  itemKey: string;
}

/** One link occurrence to a paper, as the vault index records it. */
export interface CitationToken extends PaperRef {
  /** The link's source text. */
  raw: string;
  action: CitationAction;
  /**
   * 1-based PDF physical page for a PDF link only.
   * Passed to Zotero as `?page=N`; not a printed page label.
   */
  page?: number;
  /** Offsets into the scanned string; `to` is exclusive. */
  from: number;
  to: number;
}

/**
 * Characters that cancel a search when they immediately precede the `@`.
 *
 * Word characters keep `user@example.com` from searching; a second `@` keeps
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

/**
 * The free-text query being typed immediately before `cursor`, for `@` completion.
 *
 * Spaces are allowed (`@richardson accounting`). Selecting a hit inserts
 * a standard Markdown UniZero link.
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
  if (SEARCH_HARD_TERMINATOR.test(raw)) { return; }

  const query = raw.replace(/\s+/g, " ").trim();
  return { start, query };
}

/**
 * Where an `@` query from `start` to `end` sits in a Markdown link destination,
 * as in `[label](@query)`: the completion then writes only the URL. `emptyLabelAt`
 * is where an empty `[](` starts, so the completion can replace it with a whole
 * link; an image's `!` is included, since a UniZero URI cannot be embedded.
 */
export function linkDestinationAt(line: string, start: number, end: number): { emptyLabelAt?: number } | undefined {
  if (line.slice(start - 2, start) !== "](" || line.charAt(end) !== ")") { return undefined; }
  if (line.slice(start - 3, start) !== "[](") { return {}; }
  return { emptyLabelAt: line.charAt(start - 4) === "!" ? start - 4 : start - 3 };
}

/** The text a completion inserts. Optional `page` applies only to the PDF action. */
export function citationText(
  ref: PaperRef & { authors?: string[]; title?: string; year?: string },
  action: CitationAction = "detail",
  page?: number,
): string {
  return markdownLink(paperLabel(ref, action === "pdf" ? page : undefined), {
    kind: "paper", libraryID: ref.libraryID, itemKey: ref.itemKey, action,
    ...(action === "pdf" && page ? { page } : {}),
  });
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
  ref: PaperRef & { authors?: string[]; title?: string; year?: string },
  action: CitationAction = "detail",
): void {
  const text = citationText(ref, action);
  dataTransfer.setData("text/plain", text);
  dataTransfer.setData(CITATION_DRAG_MIME, text);
  dataTransfer.effectAllowed = "copy";
}

/**
 * Wire an element so it can be dragged into a note as a Markdown UniZero link.
 * Uses plain DOM APIs so this module stays free of Obsidian imports.
 */
export function enableCitationDrag(
  element: HTMLElement,
  ref: PaperRef & { authors?: string[]; title?: string; year?: string },
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
