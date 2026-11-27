/**
 * Structural Markdown/Canvas scanning, text anchors and evidence units live in the
 * shared `@unizero/links` package (packages/links), so the plugin and the Zotero
 * add-on agree on what counts as one mention.
 */
export {
  NOCITE_TITLE,
  PDF_ANCHOR,
  canvasTextFields,
  indexedLinks,
  mayContainDocumentLinks,
  occurrenceSnippet,
  resolveTextLocation,
  retargetInlineLink,
  scanCanvasLinks,
  scanDocumentLinks,
  textAnchors,
  type CanvasTextField,
  type DocumentLink,
  type LinkUnit,
  type TextAnchor,
} from "@unizero/links";
