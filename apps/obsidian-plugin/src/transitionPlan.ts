import { canvasTextFields, scanDocumentLinks } from "./documentLinks";
import { markdownLink, paperLabel } from "./linkTarget";
import { contentHash } from "./externalIndex";
import type { PaperRef } from "./citation";

export interface TransitionEdit { from: number; to: number; text: string }
export interface TransitionPlan { id: string; format: "md" | "canvas"; before: string; after: string; hash: string;
  edits: TransitionEdit[]; count: number; skipped: string[]; examples: string[] }
export async function planTransition(id: string, format: "md" | "canvas", before: string,
  metadata: (ref: PaperRef) => Promise<{ authors: string[]; year?: string; title: string } | undefined>): Promise<TransitionPlan> {
  const edits: TransitionEdit[] = [], skipped: string[] = [], examples: string[] = [];
  let count = 0;
  async function convert(text: string): Promise<TransitionEdit[]> {
    const changes: TransitionEdit[] = [];
    for (const link of scanDocumentLinks(text).filter((l) => l.legacy && l.target.kind === "paper")) {
      if (link.target.kind !== "paper") { continue; }
      const paper = await metadata(link.target).catch(() => undefined);
      if (!paper) { skipped.push(`${link.raw}: metadata unavailable`); continue; }
      const replacement = markdownLink(paperLabel({ ...link.target, ...paper }, link.target.page), link.target);
      changes.push({ from: link.from, to: link.to, text: replacement });
      count += 1; if (examples.length < 6) { examples.push(`${link.raw} → ${replacement}`); }
    }
    return changes;
  }
  if (format === "canvas") {
    for (const field of canvasTextFields(before)) {
      const changes = await convert(field.text);
      if (changes.length) { edits.push({ from: field.from, to: field.to, text: JSON.stringify(applyEdits(field.text, changes)) }); }
    }
  } else { edits.push(...await convert(before)); }
  return { id, format, before, after: applyEdits(before, edits), hash: contentHash(before), edits, count, skipped, examples };
}
export function applyEdits(text: string, edits: TransitionEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) { text = text.slice(0, edit.from) + edit.text + text.slice(edit.to); }
  return text;
}
