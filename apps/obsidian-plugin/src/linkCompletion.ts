/**
 * What the caret is completing inside a UniZero link destination, free of Obsidian so
 * it can be tested. Each stage replaces `from..to` on the line, up to the closing `)`.
 */
import type { PaperRef } from "./citation";
import type { TextAnchor } from "./documentLinks";
import { encodeLocation, type LinkTarget, type TextLocation } from "./linkTarget";

interface Span { from: number; to: number; closes: boolean }
export type LinkCompletion =
  | Span & { stage: "target"; ref: PaperRef; query: string }
  | Span & { stage: "location"; target: LinkTarget; fragment?: string }
  | Span & { stage: "page"; ref: PaperRef; attachmentKey?: string; digits: string };

const OPENING = "](unizero://";

/**
 * Chinese punctuation mode writes these instead of `#` and `^`, and an IME reports the
 * key as "Process", so a `#` or `^` can only be recognized in the text it produced.
 */
const FRAGMENT = "(?:[#\uFF03](.*)|([\u2026\uFF3E^].*))?";
const fragmentOf = (hash?: string, bare?: string): string | undefined =>
  (hash ?? bare)?.replace(/^(?:\u2026+|\uFF3E)/, "^");

/** A `@` query that ends in `#` or `^`: go straight to the headings or blocks of the hit. */
export function jumpAt(query: string): { query: string; next: "heading" | "block" } | undefined {
  const match = /^(.*?)\s*(?:([#\uFF03])|\^|\uFF3E|\u2026+)$/s.exec(query);
  return match ? { query: match[1], next: match[2] ? "heading" : "block" } : undefined;
}

export function completionAt(line: string, cursor: number): LinkCompletion | undefined {
  const before = line.slice(0, cursor);
  const opening = before.lastIndexOf(OPENING);
  if (opening < 0) { return; }
  const start = opening + 2, uri = before.slice(start);
  if (uri.includes(")")) { return; }
  const closing = line.indexOf(")", cursor);
  const crossesLink = closing >= 0 && line.slice(cursor, closing).includes(OPENING);
  const to = closing >= 0 && !crossesLink ? closing : cursor;
  const span = (length: number): Span => ({ from: start + length, to, closes: to === closing });

  const note = new RegExp(`^(unizero://note/([^/?#]+)/([^/?#\\uFF03\\u2026\\uFF3E^]+))${FRAGMENT}$`, "s").exec(uri);
  if (note) {
    const fragment = fragmentOf(note[4], note[5]);
    if (/[^/?#)\s]/.test(line.charAt(cursor)) && fragment === undefined) { return; }
    return { ...span(note[1].length), stage: "location", fragment,
      target: { kind: "note", vaultID: decode(note[2]), uid: decode(note[3]) } };
  }
  const paper = /^(unizero:\/\/paper\/([1-9]\d*)\/([A-Za-z0-9]+))(.*)$/.exec(uri);
  if (!paper) { return; }
  const ref: PaperRef = { libraryID: Number(paper[2]), itemKey: paper[3] }, rest = paper[4];
  if (!rest && /[A-Za-z0-9]/.test(line.charAt(cursor))) { return; }
  if (/^(?:\.(?:m|p|pd)?)?$/i.test(rest)) { return { ...span(paper[1].length), stage: "target", ref, query: rest }; }
  const raw = new RegExp(`^(\\.md(?:\\?attachment=([A-Za-z0-9]+))?)${FRAGMENT}$`, "s").exec(rest);
  if (raw) {
    return { ...span(paper[1].length + raw[1].length), stage: "location", fragment: fragmentOf(raw[3], raw[4]),
      target: { kind: "paper", ...ref, action: "markdown", ...(raw[2] ? { attachmentKey: raw[2] } : {}) } };
  }
  const pdf = /^(\.pdf(?:\?attachment=([A-Za-z0-9]+))?)(?::|[?&]page=)?(\d*)$/.exec(rest);
  if (pdf) {
    return { ...span(paper[1].length + pdf[1].length), stage: "page", ref, digits: pdf[3],
      ...(pdf[2] ? { attachmentKey: pdf[2] } : {}) };
  }
  return;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** One line of the popup and the text it writes at `from..to`. `next` keeps completing. */
export interface CompletionChoice { label: string; detail?: string; text: string; next: boolean; level?: number }

export function targetChoices(
  files: { pdfs: { key: string; title: string; main: boolean }[]; artifacts: { key: string; title: string; kind: string }[] },
  query: string,
): CompletionChoice[] {
  const raws = files.artifacts.filter((file) => file.kind === "raw");
  // One attachment is the default target and survives a replacement; several are explicit.
  const choices: CompletionChoice[] = [
    ...raws.map((file) => ({ label: "Raw", detail: file.title, next: true,
      text: raws.length > 1 ? `.md?attachment=${file.key}` : ".md" })),
    ...files.pdfs.map((file) => ({ label: "PDF", detail: file.title + (file.main && files.pdfs.length > 1 ? " (default)" : ""), next: true,
      text: files.pdfs.length > 1 ? `.pdf?attachment=${file.key}` : ".pdf" })),
    { label: "Item pane", text: "", next: false },
  ];
  return choices.filter((choice) => choice.text.toLowerCase().startsWith(query.toLowerCase()));
}

export function locationChoices(anchors: Pick<TextAnchor, "location" | "line" | "level">[], fragment?: string): CompletionChoice[] {
  const typed = decode(fragment ?? "");
  const blocks = typed.startsWith("^");
  const words = (blocks ? typed.slice(1) : typed).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (location: TextLocation) => location.value && (!blocks || location.kind === "block")
    && words.every((word) => location.value.toLowerCase().includes(word));
  const found = anchors.filter((anchor) => matches(anchor.location)).map((anchor): CompletionChoice => ({
    label: `${anchor.location.kind === "block" ? "^" : ""}${anchor.location.value}`, detail: `line ${anchor.line + 1}`,
    text: encodeLocation(anchor.location), next: false, ...(anchor.level ? { level: anchor.level } : {}),
  }));
  // Without this a bare `#^` would close the popup and leave an invalid link behind.
  if (blocks && !words.length && !found.length) { return [{ label: "No block IDs in this file", detail: "Link to the whole file", text: "", next: false }]; }
  return typed ? found : [{ label: "Whole file", text: "", next: false }, ...found];
}

export function pageChoices(completion: { attachmentKey?: string; digits: string }): CompletionChoice[] {
  const whole: CompletionChoice = { label: "Whole PDF", detail: "or type a page number", text: "", next: false };
  if (!/^[1-9]\d*$/.test(completion.digits) || !Number.isSafeInteger(Number(completion.digits))) { return [whole]; }
  return [{ label: `Page ${completion.digits}`, text: `${completion.attachmentKey ? "&" : "?"}page=${completion.digits}`, next: false }, whole];
}

/** Where the caret belongs after a choice: inside the link to continue, else past it. */
export function caretAfter(completion: Span, choice: Pick<CompletionChoice, "text" | "next">): number {
  return completion.from + choice.text.length + (!choice.next && completion.closes ? 1 : 0);
}
