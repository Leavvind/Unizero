/**
 * Live-preview styling and click handling for UniZero Markdown links.
 *
 * Links render natively in both reading mode and live preview; reading-mode clicks
 * are handled by the document-level link handlers in main.ts. Inside an editor,
 * Obsidian would hand a `unizero://` URI to the operating system, so this
 * extension resolves the link under the pointer and dispatches it instead. A full
 * parse costs hundreds of milliseconds on a long Raw, so while typing the existing
 * styles are mapped through each edit, and the document is reparsed after a pause
 * only when the edit touched a line holding a UniZero link. Clicks resolve against
 * the same mapped links, parsing at once only while such a reparse is pending. The
 * first parse waits until the editor has opened, and only on-screen labels are styled.
 */

import { StateEffect, type ChangeDesc, type Extension, type Text as DocText } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorEventOpensLink } from "./linkClick";
import { scanDocumentLinks, type DocumentLink } from "./documentLinks";
import { parseLinkTargetForNavigation, type LinkTarget } from "./linkTarget";

const refreshLinkStyles = StateEffect.define<void>();
const paperMark = Decoration.mark({ class: "unizero-paper-link" });
const noteMark = Decoration.mark({ class: "unizero-note-link" });

/** Labels only; Markdown remains native and editable. No metadata requests. */
export function linkLabelRanges(links: readonly StyledLink[], cursorRanges: readonly { from: number; to: number }[]) {
  return links.filter((link) => link.labelFrom !== undefined && link.labelTo !== undefined
    && !cursorRanges.some((range) => range.from <= link.to && range.to >= link.from))
    .map((link) => ({ from: link.labelFrom!, to: link.labelTo!, kind: link.target.kind }));
}

type StyledLink = Pick<DocumentLink, "target" | "from" | "to" | "labelFrom" | "labelTo">;

/** Whether an edit replaced or inserted text strictly inside `from..to`; typing at either edge does not count. */
function editsInside(changes: ChangeDesc, from: number, to: number): boolean {
  let inside = false;
  changes.iterChangedRanges((fromA, toA) => { if (fromA < to && toA > from) { inside = true; } });
  return inside;
}

/**
 * Moves link spans through an edit. A link whose own text was edited is dropped
 * until the next parse, since the edit may have broken it.
 */
export function mapStyledLinks(links: readonly StyledLink[], changes: ChangeDesc): StyledLink[] {
  const result: StyledLink[] = [];
  for (const link of links) {
    if (editsInside(changes, link.from, link.to)) { continue; }
    result.push({ target: link.target, from: changes.mapPos(link.from, 1), to: changes.mapPos(link.to, -1),
      labelFrom: link.labelFrom === undefined ? undefined : changes.mapPos(link.labelFrom, 1),
      labelTo: link.labelTo === undefined ? undefined : changes.mapPos(link.labelTo, -1) });
  }
  return result;
}

/**
 * Whether an edit can change which UniZero links the document holds: only when a
 * line it touched held `unizero://` before or after. Ordinary typing elsewhere
 * keeps the mapped styles and costs no reparse.
 */
export function editMayChangeLinks(before: DocText | undefined, after: DocText, changes: ChangeDesc): boolean {
  let may = false;
  const holds = (doc: DocText, from: number, to: number) =>
    doc.sliceString(doc.lineAt(from).from, doc.lineAt(to).to).includes("unizero://");
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    may ||= holds(after, fromB, toB) || (before !== undefined && holds(before, fromA, toA));
  });
  return may;
}

export interface LinkHost {
  openLink(target: LinkTarget): void;
  linkMenu(event: MouseEvent, target: LinkTarget): void;
}

export function linkLivePreview(host: LinkHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      private parsed = false;
      /** UniZero links as of the last parse, mapped through every edit since. */
      private styled: StyledLink[] = [];
      decorations: DecorationSet = Decoration.none;
      private timer?: ReturnType<typeof setTimeout>;

      /** Opening an editor parses only after it yields, so the first paint is not held up. */
      constructor(private readonly view: EditorView) { this.schedule(0); }

      private parse(): void {
        const text = this.view.state.doc.toString();
        this.styled = text.includes("unizero://") ? scanDocumentLinks(text, parseLinkTargetForNavigation) : [];
        this.parsed = true;
      }

      private schedule(delay: number): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.parse();
          this.view.dispatch({ effects: refreshLinkStyles.of() });
        }, delay);
      }

      /** Labels in the viewport only: a long Raw holds far more links than are on screen. */
      private build(): void {
        const visible = this.view.visibleRanges;
        const links = this.styled.filter((link) => visible.some((range) => link.from < range.to && link.to > range.from));
        this.decorations = Decoration.set(linkLabelRanges(links, this.view.state.selection.ranges)
          .map(({ from, to, kind }) => (kind === "paper" ? paperMark : noteMark).range(from, to)), true);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          // Keep existing styles in place while typing; a reparse confirms them later,
          // and only when the edit touched a line that holds or held a UniZero link.
          const count = this.styled.length;
          this.styled = mapStyledLinks(this.styled, update.changes);
          if (this.styled.length !== count || editMayChangeLinks(update.startState?.doc, update.state?.doc ?? this.view.state.doc, update.changes)) {
            this.schedule(180);
          }
        }
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some((t) => t.effects.some((e) => e.is(refreshLinkStyles)))) {
          this.build();
        }
      }

      destroy(): void { clearTimeout(this.timer); }

      /**
       * The UniZero Markdown link at a position, for the event in hand. The mapped
       * links are exact unless an edit touched a link line and its reparse is still
       * pending; only then does a click parse at once.
       */
      linkAt(position: number): StyledLink | undefined {
        if (!this.parsed || this.timer !== undefined) {
          clearTimeout(this.timer); this.timer = undefined;
          this.parse();
          this.view.dispatch({ effects: refreshLinkStyles.of() });
        }
        return this.styled.find((l) => position >= l.from && position <= l.to);
      }
    },
    // An outer mark wraps native formatting spans once, including bold/italic labels.
    { provide: (plugin) => EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations || Decoration.none) },
  );
  // Native Markdown links retain their text and editing behavior.
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
