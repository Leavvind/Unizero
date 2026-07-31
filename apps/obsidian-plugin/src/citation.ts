/**
 * The inline citation syntax.
 *
 * Three forms, one prefix:
 *
 *   @citekey        the paper itself — opens the detail pane
 *   @citekey.md     the converted Markdown note
 *   @citekey.pdf    the PDF, opened in Zotero
 *
 * A uniform suffix is what makes the set learnable: the thing before the dot is
 * always the paper, and the dot always says which representation of it you want.
 * That is why `.pdf` is spelled the same way as `.md` rather than being marked by
 * a second `@`.
 *
 * The module is deliberately free of Obsidian imports. Both renderers — the
 * reading-mode post-processor and the live-preview CodeMirror extension — have to
 * agree on exactly which spans are citations, and the only way to guarantee that
 * is for both to call the same scanner.
 */

export type CitationAction = "detail" | "markdown" | "pdf";

export interface CitationToken {
  /** The matched text, including the `@` and any suffix. */
  raw: string;
  citekey: string;
  action: CitationAction;
  /** Offsets into the scanned string; `to` is exclusive. */
  from: number;
  to: number;
}

/**
 * Citekey characters.
 *
 * Must stay in step with the add-on's `CITEKEY_PATTERN`. Excluding `.` is what
 * lets the suffix be recognised without ambiguity; a key that legitimately
 * contains one has to be pinned to something simpler to be addressable here.
 */
export const CITEKEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const TOKEN = /@([A-Za-z][A-Za-z0-9_-]*)(\.md|\.pdf)?/g;

/**
 * Characters that cancel a match when they immediately precede the `@`.
 *
 * This is the whole defence against false positives, and each entry earns its
 * place: word characters keep `user@example.com` from citing `@example`; a second
 * `@` keeps `@@key` from matching its tail; `/` and `.` cover paths and hostnames;
 * and `\` gives the user an escape — `\@notacitation` renders as written.
 */
const CANCELLING_PREFIX = /[A-Za-z0-9_@/\\.]/;

function actionFor(suffix: string | undefined): CitationAction {
  if (suffix === ".md") { return "markdown"; }
  if (suffix === ".pdf") { return "pdf"; }
  return "detail";
}

export function isValidCitekey(value: string): boolean {
  return CITEKEY_PATTERN.test(String(value || ""));
}

/** Every citation in `text`, in order. */
export function scanCitations(text: string): CitationToken[] {
  const tokens: CitationToken[] = [];
  TOKEN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const from = match.index;
    if (from > 0 && CANCELLING_PREFIX.test(text.charAt(from - 1))) { continue; }
    tokens.push({
      raw: match[0],
      citekey: match[1],
      action: actionFor(match[2]),
      from,
      to: from + match[0].length,
    });
  }
  return tokens;
}

/**
 * The citekey being typed immediately before `cursor`, for `@` completion.
 *
 * Returns undefined once the prefix stops looking like the start of a citation,
 * so the suggester closes instead of following the caret across unrelated text.
 */
export function citationPrefixAt(
  line: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const before = line.slice(0, cursor);
  const match = before.match(/@([A-Za-z][A-Za-z0-9_-]*)?$/);
  if (!match) { return; }

  const start = before.length - match[0].length;
  if (start > 0 && CANCELLING_PREFIX.test(line.charAt(start - 1))) { return; }
  return { start, query: match[1] || "" };
}

/** The text a completion inserts. */
export function citationText(citekey: string, action: CitationAction = "detail"): string {
  const suffix = action === "markdown" ? ".md" : action === "pdf" ? ".pdf" : "";
  return `@${citekey}${suffix}`;
}
