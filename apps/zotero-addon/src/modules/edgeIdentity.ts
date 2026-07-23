/**
 * A stable name for one end of a citation edge.
 *
 * The cache stores whole resolved records, and "is this the same paper?" is asked
 * of them in several places by comparing whichever identifier happens to be at
 * hand. That works for one item pane at a time. It does not survive being asked
 * across the library — which is what any cross-item view (who cites this, what do
 * these two share) has to do, over records written by three different engines, each
 * normalising DOIs its own way.
 *
 * So the normalisation is pinned down here and written into the cached record at
 * save time, rather than recomputed by every future reader from whatever rules it
 * happens to implement. One string per reference; the cost is negligible next to
 * the record it sits in.
 *
 * The value is an opaque key, not a URL: it exists to be compared, and prefixing by
 * scheme keeps two namespaces from colliding on a bare number.
 */

import { bareDOI } from "./scholarlyHttp";

/**
 * Ordered by how reliably two records for the same paper end up agreeing.
 *
 * A DOI is the one identifier all three engines report and the one Zotero items
 * carry, so it goes first. arXiv IDs are next: stable, but present only for
 * preprints and often alongside a DOI for the published version — which is why they
 * never override a DOI here. A Semantic Scholar paper ID is last because it is
 * S2-internal, so it matches only other S2-sourced records.
 */
export function edgeIdentity(info: ItemBaseInfo | undefined): string | undefined {
  const identifiers = info?.identifiers;
  if (!identifiers) { return undefined; }

  const doi = bareDOI(String(identifiers.DOI || "")).toLowerCase();
  if (doi) { return `doi:${doi}`; }

  const arxiv = String(identifiers.arXiv || "").trim().toLowerCase()
    .replace(/^arxiv[:\s]*/, "")
    .replace(/v\d+$/, "");
  if (arxiv) { return `arxiv:${arxiv}`; }

  const paperID = String(identifiers.paperID || "").trim().toLowerCase();
  if (paperID) { return `s2:${paperID}`; }

  // Reference strings that never resolved to any identifier stay anonymous. They
  // are still shown and still cached; they simply cannot be an edge endpoint, and
  // inventing a title-derived key for them would silently merge distinct papers.
  return undefined;
}

/**
 * Copy a list for persistence, stamping each entry with its edge key and where the
 * entry came from.
 *
 * Copies rather than mutates: these records are the same objects the panel is
 * rendering from, and persistence should not be able to change what is on screen.
 * `_item` is dropped because it is a live Zotero object — it cannot be serialised
 * meaningfully and would only survive as an empty husk.
 */
export function forPersistence(entries: ItemBaseInfo[], producedBy: string): ItemBaseInfo[] {
  return entries.map((entry) => {
    const { _item, ...rest } = entry;
    return { ...rest, edge: edgeIdentity(entry), producedBy };
  });
}
