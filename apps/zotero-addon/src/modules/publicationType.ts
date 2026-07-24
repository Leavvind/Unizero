/**
 * Map provider work/paper records onto Zotero item-type strings.
 *
 * The References and Citations routes both need this classification, and the
 * OpenAlex/Semantic Scholar shapes are provider-wide rather than route-specific,
 * so the logic lives here instead of being copied into each API module.
 */

/** Classify an OpenAlex work into a Zotero item type. */
export function fromOpenAlexPublicationType(work: any): string {
  const workType = String(work?.type || "").toLocaleLowerCase();
  const sourceType = String(
    work?.primary_location?.source?.type || "",
  ).toLocaleLowerCase();
  if (workType === "preprint") { return "preprint"; }
  if (sourceType === "conference" || workType.includes("proceeding")) {
    return "conferencePaper";
  }
  if (workType.includes("book")) { return "bookSection"; }
  return "journalArticle";
}

/** Classify a Semantic Scholar paper into a Zotero item type. */
export function fromSemanticScholarPublicationType(
  paper: any,
  arxiv?: string,
  doi?: string,
): string {
  const types = Array.isArray(paper?.publicationTypes)
    ? paper.publicationTypes.map((value: unknown) =>
      String(value).toLocaleLowerCase())
    : [];
  if (arxiv && !doi) { return "preprint"; }
  if (types.some((value: string) => value.includes("conference"))) {
    return "conferencePaper";
  }
  if (types.some((value: string) => value.includes("book"))) {
    return "bookSection";
  }
  return "journalArticle";
}
