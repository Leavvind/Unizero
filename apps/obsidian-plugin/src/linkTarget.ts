import type { CitationAction, PaperRef } from "./citation";

export type TextLocation = { kind: "heading" | "block"; value: string };
export type LinkTarget =
  | ({ kind: "paper"; action: CitationAction; attachmentKey?: string; page?: number; location?: TextLocation } & PaperRef)
  | { kind: "note"; vaultID: string; uid: string; location?: TextLocation };

/** What a link points at, for lists: empty for a paper's Item pane or a whole Vault document. */
export function describeTarget(target: LinkTarget): string {
  const file = target.kind !== "paper" ? "" : target.action === "markdown" ? "Raw" : target.action === "pdf" ? "PDF" : "";
  const page = target.kind === "paper" && target.page ? `p. ${target.page}` : "";
  const place = target.location ? `${target.location.kind === "block" ? "^" : "#"}${target.location.value}` : "";
  return [file, page, place].filter(Boolean).join(" ");
}

const KEY = /^[A-Za-z0-9]+$/;
export function validIdentity(value: string): boolean {
  return !!value && value.trim() === value && !/[\u0000-\u001f\u007f/\\]/.test(value)
    && value !== "." && value !== "..";
}

/** Strict grammar; every URI component is decoded exactly once. No URL normalization. */
export function parseLinkTarget(uri: string): LinkTarget | undefined {
  try {
    const match = /^unizero:\/\/(paper|note)\/([^/?#]+)\/([^/?#]+)(?:\?([^#]*))?(?:#(.+))?$/.exec(uri);
    if (!match) { return; }
    const [, kind, first, second, query, fragment] = match;
    const params = new Map<string, string>();
    if (query !== undefined) {
      if (!query) { return; }
      for (const pair of query.split("&")) {
        const parts = pair.split("=");
        if (parts.length !== 2) { return; }
        const name = decodeURIComponent(parts[0]);
        if (params.has(name) || !["attachment", "page"].includes(name)) { return; }
        params.set(name, decodeURIComponent(parts[1]));
      }
    }
    const value = fragment === undefined ? undefined : decodeURIComponent(fragment);
    if (value !== undefined && (!value || /[\u0000-\u001f\u007f]/.test(value))) { return; }
    const location: TextLocation | undefined = value === undefined ? undefined
      : { kind: value.startsWith("^") ? "block" : "heading", value: value.startsWith("^") ? value.slice(1) : value };
    if (location && (!location.value || (location.kind === "block" && !/^[A-Za-z0-9-]+$/.test(location.value)))) { return; }
    if (kind === "note") {
      const vaultID = decodeURIComponent(first), uid = decodeURIComponent(second);
      if (params.size || !validIdentity(vaultID) || !validIdentity(uid)) { return; }
      return { kind, vaultID, uid, ...(location ? { location } : {}) };
    }
    if (!/^[1-9]\d*$/.test(first) || !Number.isSafeInteger(Number(first))) { return; }
    const address = /^([A-Za-z0-9]+)(\.md|\.pdf)?$/.exec(decodeURIComponent(second));
    if (!address) { return; }
    const action: CitationAction = address[2] === ".md" ? "markdown" : address[2] === ".pdf" ? "pdf" : "detail";
    const attachmentKey = params.get("attachment"), pageText = params.get("page");
    if (attachmentKey !== undefined && (!KEY.test(attachmentKey) || action === "detail")) { return; }
    if (pageText !== undefined && (action !== "pdf" || !/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(Number(pageText)))) { return; }
    if (location && action !== "markdown") { return; }
    return { kind: "paper", libraryID: Number(first), itemKey: address[1], action,
      ...(attachmentKey ? { attachmentKey } : {}), ...(pageText ? { page: Number(pageText) } : {}), ...(location ? { location } : {}) };
  } catch { return; }
}

/**
 * Clicks also accept unfinished location completion. Recover only the location:
 * the file identity and explicit attachment must still pass the strict grammar.
 * Stored links and indexes continue to use parseLinkTarget.
 */
export function parseLinkTargetForNavigation(uri: string): LinkTarget | undefined {
  const exact = parseLinkTarget(uri);
  if (exact) { return exact; }
  const match = /^(unizero:\/\/paper\/[1-9]\d*\/[A-Za-z0-9]+\.md(?:\?attachment=[A-Za-z0-9]+)?|unizero:\/\/note\/[^/?#]+\/[^/?#^＃＾…]+)([#^＃＾…].*)$/s.exec(uri);
  if (!match) { return; }
  const base = parseLinkTarget(match[1]);
  if (!base) { return; }
  // Normalize the same shorthand/IME punctuation as the location suggester.
  const fragment = match[2].replace(/^[#＃]/, "").replace(/^(?:…+|＾)/, "^");
  return parseLinkTarget(`${match[1]}#${fragment}`) ?? base;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function encodeLocation(location: TextLocation): string {
  return `#${encode(`${location.kind === "block" ? "^" : ""}${location.value}`)}`;
}
export function serializeLinkTarget(target: LinkTarget): string {
  let uri: string;
  if (target.kind === "note") {
    uri = `unizero://note/${encode(target.vaultID)}/${encode(target.uid)}`;
  } else {
    uri = `unizero://paper/${target.libraryID}/${encode(target.itemKey)}${target.action === "pdf" ? ".pdf" : target.action === "markdown" ? ".md" : ""}`;
    const params: string[] = [];
    if (target.attachmentKey !== undefined) { params.push(`attachment=${encode(target.attachmentKey)}`); }
    if (target.page !== undefined) { params.push(`page=${target.page}`); }
    if (params.length) { uri += `?${params.join("&")}`; }
  }
  if (target.location) { uri += encodeLocation(target.location); }
  if (!parseLinkTarget(uri)) { throw new Error("Invalid UniZero link target"); }
  return uri;
}

export function targetIdentity(target: LinkTarget): string {
  return target.kind === "paper" ? `paper:${target.libraryID}/${target.itemKey}`
    : `note:${encode(target.vaultID)}/${encode(target.uid)}`;
}
export function markdownLink(label: string, target: LinkTarget): string {
  return `[${label.replace(/\r?\n/g, " ").replace(/[\\\[\]`*_<>]/g, "\\$&")}](${serializeLinkTarget(target)})`;
}
export function paperLabel(paper: { authors?: string[]; year?: string; title?: string } & PaperRef, page?: number): string {
  const authors = (paper.authors || []).filter(Boolean);
  const surname = (name: string) => name.trim().split(/\s+/).pop() || "";
  const lead = authors.length ? surname(authors[0]) : "";
  const credit = authors.length > 2 ? `${lead} et al.` : authors.length === 2 ? `${lead} & ${surname(authors[1])}` : lead;
  const label = [credit || paper.title || `${paper.libraryID}/${paper.itemKey}`, paper.year].filter(Boolean).join(", ");
  return page ? `${label}, p. ${page}` : label;
}
