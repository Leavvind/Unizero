import type { BridgeArtifacts, BridgeMarkdown } from "./bridge";

export type MarkdownListing = Pick<BridgeArtifacts, "artifacts" | "markdowns">;

/** Older add-ons expose only Raw candidates; an empty new list is authoritative. */
export function markdownAttachments(files: MarkdownListing): BridgeMarkdown[] {
  if (files.markdowns) { return files.markdowns; }
  const raws = files.artifacts.filter((file) => file.kind === "raw");
  return raws.map((file) => ({ ...file, purpose: "raw", main: raws.length === 1 }));
}

/** Attachment names lead; keys are shown only to disambiguate identical names. */
export function markdownAttachmentLabel(file: BridgeMarkdown, all: BridgeMarkdown[]): string {
  const title = file.title || (file.purpose === "raw" ? "Raw" : "Markdown");
  const duplicate = all.some((other) => other.key !== file.key && (other.title || (other.purpose === "raw" ? "Raw" : "Markdown")) === title);
  return duplicate ? `${title} · ${file.key}` : title;
}

export function markdownAttachmentDetail(file: BridgeMarkdown): string {
  return file.main ? "Raw · default" : file.purpose === "raw" ? "Raw" : "Markdown";
}
