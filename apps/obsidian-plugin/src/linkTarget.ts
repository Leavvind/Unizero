import type { PaperRef } from "./citation";
import { NOCITE_TITLE, serializeLinkTarget, type LinkTarget } from "@unizero/links";

/** The URI grammar is shared with the Zotero add-on: packages/links/src/linkTarget.ts. */
export {
  encodeLocation,
  parseLinkTarget,
  parseLinkTargetForNavigation,
  serializeLinkTarget,
  targetIdentity,
  validIdentity,
  type LinkTarget,
  type TextLocation,
} from "@unizero/links";

/** What a link points at, for lists: empty for a paper's Item pane or a whole Vault document. */
export function describeTarget(target: LinkTarget): string {
  const file = target.kind !== "paper" ? "" : target.action === "markdown" ? "Raw" : target.action === "pdf" ? "PDF" : "";
  const page = target.kind === "paper" && target.page ? `p. ${target.page}` : "";
  const place = target.location ? `${target.location.kind === "block" ? "^" : "#"}${target.location.value}` : "";
  return [file, page, place].filter(Boolean).join(" ");
}

/** `nocite` adds the render-only title (`-@`): the link opens as usual but is never indexed. */
export function markdownLink(label: string, target: LinkTarget, nocite = false): string {
  return `${markdownLabel(label)}(${serializeLinkTarget(target)}${nocite ? NOCITE_SUFFIX : ""})`;
}
/** The bracketed, escaped label of a Markdown link. */
export function markdownLabel(label: string): string {
  return `[${label.replace(/\r?\n/g, " ").replace(/[\\\[\]`*_<>]/g, "\\$&")}]`;
}
/** What follows the destination of a render-only link, inside its parentheses. */
export const NOCITE_SUFFIX = ` "${NOCITE_TITLE}"`;
export function paperLabel(paper: { authors?: string[]; year?: string; title?: string } & PaperRef, page?: number): string {
  const authors = (paper.authors || []).filter(Boolean);
  const surname = (name: string) => name.trim().split(/\s+/).pop() || "";
  const lead = authors.length ? surname(authors[0]) : "";
  const credit = authors.length > 2 ? `${lead} et al.` : authors.length === 2 ? `${lead} & ${surname(authors[1])}` : lead;
  const label = [credit || paper.title || `${paper.libraryID}/${paper.itemKey}`, paper.year].filter(Boolean).join(", ");
  return page ? `${label}, p. ${page}` : label;
}
