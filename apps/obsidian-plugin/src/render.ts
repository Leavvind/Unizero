/**
 * Live-preview click handling for UniZero Markdown links.
 *
 * Links render natively in both reading mode and live preview; reading-mode clicks
 * are handled by the document-level link handlers in main.ts. Inside an editor,
 * Obsidian would hand a `unizero://` URI to the operating system, so this
 * extension resolves the link under the pointer and dispatches it instead. A full
 * parse costs hundreds of milliseconds on a long Raw, so a document is parsed only
 * when a click needs it and the parse is reused until the document changes.
 */

import type { Extension, Text as DocText } from "@codemirror/state";
import { EditorView, type PluginValue, ViewPlugin } from "@codemirror/view";
import { editorEventOpensLink } from "./linkClick";
import { scanDocumentLinks, type DocumentLink } from "./documentLinks";
import type { LinkTarget } from "./linkTarget";

export interface LinkHost {
  openLink(target: LinkTarget): void;
  linkMenu(event: MouseEvent, target: LinkTarget): void;
}

export function linkLivePreview(host: LinkHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      private parsed?: { doc: DocText; links: DocumentLink[] };

      constructor(private readonly view: EditorView) {}

      /** The UniZero Markdown link at a position, for the event in hand. */
      linkAt(position: number): DocumentLink | undefined {
        const doc = this.view.state.doc, text = doc.toString();
        if (!text.includes("unizero://")) { return undefined; }
        if (this.parsed?.doc !== doc) { this.parsed = { doc, links: scanDocumentLinks(text) }; }
        return this.parsed.links.find((l) => position >= l.from && position <= l.to);
      }
    },
  );
  // Native Markdown links retain their DOM and label rendering. Only dispatch changes.
  const handle = (event: MouseEvent, view: EditorView): boolean => {
    const target = event.target as Element;
    if (event.type !== "contextmenu") {
      if (!editorEventOpensLink(event, target, view.contentDOM)) { return false; }
      // Finishing a drag selection over a link is not a click on it.
      const selection = view.dom.ownerDocument.getSelection();
      if (event.type === "click" && target.closest(".is-live-preview") && selection && !selection.isCollapsed
        && (target.contains(selection.anchorNode) || target.contains(selection.focusNode))) { return false; }
    }
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) { return false; }
    const link = view.plugin(plugin)?.linkAt(position);
    if (!link) { return false; }
    event.preventDefault();
    // Obsidian listens on an ancestor of this editor and would open the URI as well.
    event.stopPropagation();
    if (event.type === "contextmenu") { host.linkMenu(event, link.target); } else { host.openLink(link.target); }
    return true;
  };
  return [plugin, EditorView.domEventHandlers({ click: handle, mousedown: handle, contextmenu: handle })];
}
