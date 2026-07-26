/**
 * Conversion adapter between Zotero and the paper runtime.
 *
 * Ported from ZoMiner's `modules/zotero-adapter.js`, with identical behaviour.
 *
 * Per AGENTS.md, the adapter is the only place in the add-on that mutates Zotero
 * items directly; feature modules only describe *what* to convert, and this file
 * decides how that lands on attachments and tags.
 *
 * Recognising and overwriting artifacts no longer depends on attachment titles —
 * see artifactIdentity.ts. The title constants here have only two remaining uses:
 * the display name of a new artifact, and the criterion for adopting a
 * pre-migration one.
 */

import type { ConvertRequest, JobResult } from "../runtime-client/contracts";
import {
  adoptArtifact, findArtifacts, isArtifact, markArtifact,
  type ArtifactKind,
} from "./artifactIdentity";
import { readItemPaperIdentifiers } from "../modules/itemIdentifiers";
import { libraryScope } from "./libraryScope";
import { ensureMarkdownLink } from "./markdownLinkRegistry";

const GENERATED_TAG = "MD/generated";
const MD_ATTACHMENT_TITLE = "ZoMiner MD";
/** Title used by earlier ZoMiner versions; still recognised when overwriting. */
const LEGACY_ATTACHMENT_TITLE = "Academic MD";
const MD_COPY_ATTACHMENT_TITLE = "ZoMiner MD Copy";
/** The Chinese title this add-on used before the interface was unified on English. */
const LEGACY_MD_COPY_ATTACHMENT_TITLE = "ZoMiner MD 副本";
const TABLES_ATTACHMENT_TITLE = "ZoMiner Tables";

export interface ConversionTarget {
  /** A standalone PDF attachment has no parent item. */
  parent: Zotero.Item | null;
  attachment: Zotero.Item;
  /** Absolute local path of the attachment; the runtime reads the file from it. */
  path: string;
  /** Not the main PDF (supplementary material). Affects the artifact title suffix. */
  isSupplement: boolean;
}

function pdfAttachments(item: Zotero.Item): Zotero.Item[] {
  const pdfs: Zotero.Item[] = [];
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (attachment && attachment.attachmentContentType === "application/pdf") {
      pdfs.push(attachment);
    }
  }
  return pdfs;
}

/** Main PDF = Zotero's best attachment; falls back to the first PDF if that is not one. */
async function mainPdfId(
  item: Zotero.Item,
  pdfs: Zotero.Item[],
): Promise<number | null> {
  if (!pdfs.length) { return null; }
  const best = await item.getBestAttachment();
  if (best && best.attachmentContentType === "application/pdf") { return best.id; }
  return pdfs[0].id;
}

/**
 * Flatten the user's selection into the list of PDFs to convert.
 *
 * Selecting a parent item includes every PDF under it (supplements included);
 * selecting an attachment includes only that one. Deduplicated by attachment.id,
 * because selecting both a parent and its attachment is very common.
 */
export async function conversionTargets(
  items: Zotero.Item[],
): Promise<ConversionTarget[]> {
  const targets: ConversionTarget[] = [];
  const seen = new Set<number>();

  for (const item of items) {
    if (item.isRegularItem()) {
      const pdfs = pdfAttachments(item);
      const mainId = await mainPdfId(item, pdfs);
      for (const attachment of pdfs) {
        if (seen.has(attachment.id)) { continue; }
        seen.add(attachment.id);
        const path = await attachment.getFilePathAsync();
        if (!path) {
          // The attachment record exists but the file does not (never synced
          // down, or moved).
          ztoolkit.log(`attachment file missing: ${attachment.key}`);
          continue;
        }
        targets.push({
          parent: item,
          attachment,
          path,
          isSupplement: attachment.id !== mainId,
        });
      }
    } else if (item.isAttachment()) {
      if (seen.has(item.id) || item.attachmentContentType !== "application/pdf") {
        continue;
      }
      seen.add(item.id);
      const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
      const path = await item.getFilePathAsync();
      if (!path) {
        ztoolkit.log(`attachment file missing: ${item.key}`);
        continue;
      }
      let supplement = false;
      if (parent) {
        supplement = item.id !== await mainPdfId(parent, pdfAttachments(parent));
      }
      targets.push({ parent, attachment: item, path, isSupplement: supplement });
    }
  }

  return targets;
}

/**
 * Flatten Zotero metadata into the shape the runtime contract expects, so
 * templates can project it into frontmatter.
 */
export function conversionPayload(
  target: ConversionTarget,
  templateId: string,
): ConvertRequest {
  const { parent, attachment } = target;
  const payload: ConvertRequest = {
    pdf_path: target.path,
    attachment_key: attachment.key,
    attachment_title: attachment.getField("title") || "",
    is_supplement: !!target.isSupplement,
    library_id: attachment.libraryID || 1,
    library_scope: libraryScope(attachment.libraryID || 1),
    template: templateId || "paper-to-markdown",
  };

  if (!parent) {
    payload.title = attachment.getField("title") || "";
    return payload;
  }

  payload.item_key = parent.key;
  payload.title = parent.getField("title") || "";
  payload.publication = parent.getField("publicationTitle") || "";
  payload.abstract = parent.getField("abstractNote") || "";
  const year = (parent.getField("date") || "").match(/\d{4}/);
  payload.year = year ? year[0] : "";
  payload.authors = parent.getCreators().map((creator) =>
    creator.firstName
      ? `${creator.firstName} ${creator.lastName}`
      : creator.lastName,
  );

  // The Semantic Scholar link and citation count in a converted document come
  // from what Complete Metadata resolved and stored on the item, so the runtime
  // never has to guess a paper from its title a second time.
  const identifiers = readItemPaperIdentifiers(parent);
  payload.doi = identifiers.doi || "";
  payload.s2_paper_id = identifiers.semanticScholarPaperId || "";
  payload.citations = identifiers.citations;

  // Better BibTeX is an optional dependency: use its citekey when installed,
  // otherwise omit the field.
  try {
    const key = (Zotero as any).BetterBibTeX?.KeyManager?.get(parent.id);
    if (key && key.citationKey) { payload.citekey = key.citationKey; }
  } catch (error) {
    // BBT is not installed, or has not finished initialising.
  }

  return payload;
}

/**
 * Context for registering one round of artifacts.
 *
 * `source` and `wasConverted` both serve artifact identity: the former
 * distinguishes artifacts of the same kind produced from different PDFs under one
 * item, the latter is the only extra evidence available when adopting a legacy
 * artifact.
 */
interface ArtifactContext {
  parent: Zotero.Item;
  /** Key of the source PDF attachment. */
  source: string;
  /** The item already carried GENERATED_TAG *before* this conversion. */
  wasConverted: boolean;
  /** Source suffix appended to artifact titles when an item has several PDFs. */
  suffix: string;
}

/**
 * Find pre-migration artifacts that were generated but never tagged.
 *
 * Only accepted when the item had been converted before — otherwise an
 * attachment that merely happens to be called "ZoMiner MD" is the user's own
 * file and must not be touched. This is where the "same name means delete" data
 * loss path is blocked.
 */
function legacyArtifacts(
  context: ArtifactContext,
  titles: string[],
  shape: (attachment: Zotero.Item) => boolean,
): Zotero.Item[] {
  if (!context.wasConverted) { return []; }
  const found: Zotero.Item[] = [];
  for (const id of context.parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment || isArtifact(attachment) || !shape(attachment)) { continue; }
    if (titles.includes(attachment.getField("title"))) { found.push(attachment); }
  }
  return found;
}

/**
 * Linked attachment: Zotero stores only the path, while the text stays in the
 * user's Markdown library.
 *
 * This is a living document — the user keeps editing it, so the content must
 * never be overwritten; only the link is maintained. If the link already points
 * at the same file, do nothing; an artifact of the same kind pointing elsewhere
 * is a leftover from a previous output path, so delete and recreate it.
 */
async function attachMarkdown(
  context: ArtifactContext,
  path: string,
): Promise<void> {
  const title = MD_ATTACHMENT_TITLE + context.suffix;
  const legacyTitle = LEGACY_ATTACHMENT_TITLE + context.suffix;
  // On Windows the same path can appear with / or \, so normalise before comparing.
  const normalize = (value: string) => String(value || "").replace(/\//g, "\\");

  const candidates = [
    ...findArtifacts(context.parent, "markdown", context.source, title),
    ...legacyArtifacts(context, [title, legacyTitle],
      (attachment) => !!attachment.isLinkedFileAttachment?.()),
  ];

  let current: Zotero.Item | null = null;
  const stale: Zotero.Item[] = [];
  for (const attachment of candidates) {
    const existingPath = await attachment.getFilePathAsync();
    if (!current && existingPath && normalize(existingPath) === normalize(path)) {
      current = attachment;
      continue;
    }
    stale.push(attachment);
  }

  // Remove every artifact of this kind that points at an old path. The previous
  // implementation stopped at the first path match, which left permanently
  // unclearable dead links on items whose output directory had changed.
  for (const attachment of stale) { await attachment.eraseTx(); }

  if (current) {
    // This may be a legacy artifact we just recognised: add the tag and record so
    // the next run does not have to rely on the title.
    if (!isArtifact(current)) {
      await adoptArtifact(current, "markdown", context.source);
    }
    return;
  }

  const created = await Zotero.Attachments.linkFromFile({
    file: path,
    parentItemID: context.parent.id,
    title,
    contentType: "text/markdown",
  });
  await markArtifact(created, "markdown", context.source);
  ztoolkit.log(`linked MD attachment: ${path}`);
}

/**
 * One-way snapshot: copy the file into Zotero storage, where it travels with
 * Zotero sync. The copy in Zotero is read-only — every re-conversion overwrites it.
 *
 * `legacyTitles` names titles this artifact used to be created with, so untagged
 * copies from older versions are still found and replaced instead of duplicated.
 */
async function attachImportedCopy(
  context: ArtifactContext,
  kind: ArtifactKind,
  path: string,
  title: string,
  contentType: string,
  legacyTitles: string[] = [],
): Promise<void> {
  const imported = (attachment: Zotero.Item) =>
    !!attachment.isImportedAttachment?.();

  const candidates = [
    ...findArtifacts(context.parent, kind, context.source, title),
    ...legacyArtifacts(context, [title, ...legacyTitles], imported),
  ];
  for (const attachment of candidates) { await attachment.eraseTx(); }

  const created = await Zotero.Attachments.importFromFile({
    file: path,
    parentItemID: context.parent.id,
    title,
    contentType,
  });
  await markArtifact(created, kind, context.source);
  ztoolkit.log(`imported attachment '${title}': ${path}`);
}

/**
 * Register the artifacts once a conversion finishes.
 *
 * Each kind gets its own try/catch: a failed table export must not stop
 * already-converted Markdown from being attached.
 */
export async function markConverted(
  target: ConversionTarget,
  result: JobResult | undefined,
  options: { mdSnapshot: boolean; markdownUrl: string },
): Promise<void> {
  const parent = target.parent;
  if (!parent) { return; }

  // Must be read before addTag: asking after tagging always answers true, which
  // destroys the evidence. When adopting a legacy artifact it is the only proof
  // that an identically named attachment really was generated by us.
  const wasConverted = parent.hasTag(GENERATED_TAG);
  parent.addTag(GENERATED_TAG);
  await parent.saveTx();

  const outcome = result || {};
  const context: ArtifactContext = {
    parent,
    source: target.attachment.key,
    wasConverted,
    suffix: target.isSupplement
      ? ` — ${target.attachment.getField("title") || target.attachment.key}`
      : "",
  };

  if (outcome.md_path) {
    await attachMarkdown(context, outcome.md_path);
    // The Collection view represents the paper's main conversion. Supplements
    // have their own attachments but must not replace the paper-level note link.
    if (!target.isSupplement) {
      await ensureMarkdownLink(parent, options.markdownUrl);
    }
    if (options.mdSnapshot) {
      try {
        await attachImportedCopy(
          context, "markdown-copy", outcome.md_path,
          MD_COPY_ATTACHMENT_TITLE + context.suffix, "text/markdown",
          [LEGACY_MD_COPY_ATTACHMENT_TITLE + context.suffix],
        );
      } catch (error) {
        ztoolkit.log(`md snapshot attach failed: ${error}`);
      }
    }
  }

  if (outcome.tables_html_path) {
    try {
      await attachImportedCopy(
        context, "tables", outcome.tables_html_path,
        TABLES_ATTACHMENT_TITLE + context.suffix, "text/html",
      );
    } catch (error) {
      ztoolkit.log(`tables attach failed: ${error}`);
    }
  }

}
