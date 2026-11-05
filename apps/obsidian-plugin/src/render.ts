/**
 * The two places Obsidian renders Markdown, and the two ways to hook them.
 *
 * Reading mode gets a post-processor; live preview gets a CodeMirror extension.
 * Both matter here for one reason worth stating: **Canvas uses both.** A canvas
 * text node is a live-preview editor while it is being edited and a rendered
 * block the rest of the time, and a file node embeds a normal Markdown view. So
 * the citation syntax works on a canvas without this plugin knowing that canvases
 * exist — no canvas internals, no custom node type, nothing to break when
 * Obsidian changes its canvas implementation.
 */

import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder, StateEffect, type Text as DocText } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { scanCitations, type CitationToken } from "./citation";
import { editorEventOpensLink } from "./linkClick";
import { createPill, type PillHost } from "./pill";
import { legacyLinksInLines, mapDocumentLinks, scanDocumentLinks, type DocumentLink } from "./documentLinks";

/** Pause after the last edit before a document with citations is parsed again. */
const RESCAN_DELAY_MS = 400;
const legacyRescanned = StateEffect.define<null>();

/** Ancestors whose text is never a citation. */
const INERT_TAGS = new Set(["CODE", "PRE", "A", "KBD", "SAMP"]);

class CitationChild extends MarkdownRenderChild {
  constructor(
    element: HTMLElement,
    private readonly teardown: () => void,
  ) {
    super(element);
  }

  onunload(): void {
    this.teardown();
  }
}

/**
 * Reading-mode post-processor.
 *
 * Runs per rendered block, so it walks only the text nodes Obsidian just built.
 * Each pill is registered as a render child, which is what guarantees the store
 * subscription is dropped when the block is recycled — panning a canvas past a
 * hundred cards would otherwise leak a listener per card per pass.
 */
export function citationPostProcessor(host: PillHost) {
  return (element: HTMLElement, context: MarkdownPostProcessorContext): void => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        let parent = node.parentElement;
        while (parent && parent !== element) {
          if (INERT_TAGS.has(parent.tagName) || parent.hasClass("unizero-pill")) {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }
        return node.nodeValue && node.nodeValue.includes("@")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    // Collected before mutating: replacing a text node invalidates the walker.
    const targets: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      targets.push(current as Text);
      current = walker.nextNode();
    }
    if (!targets.length) { return; }

    // `section.text` is the whole document; this runs once per rendered block.
    const section = context.getSectionInfo(element);
    const allowed = section ? legacyLinksInLines(section.text, section.lineStart, section.lineEnd) : undefined;

    for (const node of targets) {
      const text = node.nodeValue || "";
      const permitted = allowed || scanDocumentLinks(text).filter((link) => link.legacy);
      const tokens = scanCitations(text).filter((token) => permitted.some((link) => link.raw === token.raw));
      if (!tokens.length) { continue; }

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const token of tokens) {
        if (token.from > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, token.from)));
        }
        const pill = createPill(host, token);
        fragment.appendChild(pill.element);
        context.addChild(new CitationChild(pill.element, pill.destroy));
        cursor = token.to;
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      node.parentNode?.replaceChild(fragment, node);
    }
  };
}

class CitationWidget extends WidgetType {
  private teardown?: () => void;

  constructor(
    private readonly host: PillHost,
    private readonly token: CitationToken,
  ) {
    super();
  }

  /**
   * Widgets are recreated on every decoration rebuild. Telling CodeMirror when
   * two are equivalent is what stops a pill from being torn down and re-subscribed
   * on every keystroke elsewhere in the document.
   */
  eq(other: CitationWidget): boolean {
    return other.token.libraryID === this.token.libraryID &&
      other.token.itemKey === this.token.itemKey &&
      other.token.action === this.token.action &&
      other.token.page === this.token.page;
  }

  toDOM(): HTMLElement {
    const pill = createPill(this.host, this.token);
    this.teardown = pill.destroy;
    return pill.element;
  }

  destroy(): void {
    this.teardown?.();
    this.teardown = undefined;
  }

  /**
   * `true` → CodeMirror ignores the event (the pill's DOM handlers win).
   *
   * The WidgetType default is "ignore everything". An earlier override listed
   * only pointer events and returned `false` for the rest — including
   * `selectionchange`. The browser then reported a caret inside the replace
   * range, the decoration rebuild dropped the widget, and a left-click looked
   * like "enter edit mode". Keep keyboard events with the editor so arrows
   * still walk past a pill; ignore everything else.
   */
  ignoreEvent(event: Event): boolean {
    return !/^key/.test(event.type);
  }
}

/**
 * True when the node at this position is code, math, or a link's internals.
 *
 * Live preview has no DOM to inspect at decoration time, so the syntax tree is
 * the equivalent of the reading-mode ancestor check. Obsidian's node names are
 * not a stable public API, which is why this matches on substrings of the token
 * names rather than on exact values.
 */
function isInertRange(view: EditorView, from: number, to: number): boolean {
  let inert = false;
  syntaxTree(view.state).iterate({
    from,
    to,
    enter(node) {
      const name = node.type.name;
      if (/inline-code|codeblock|hmd-codeblock|math|formatting-link|hmd-internal-link|url/.test(name)) {
        inert = true;
      }
    },
  });
  return inert;
}

/**
 * Live-preview extension.
 *
 * Two rules make the result editable rather than merely pretty:
 *
 * - A full parse costs hundreds of milliseconds on a long Raw, so typing never waits
 *   for one. A document without legacy citations is never parsed here; otherwise
 *   known pills follow the edit and the parse runs after a pause. New-style links
 *   render natively and are parsed only when a click needs one.
 * - A citation the cursor or selection touches is left as raw text. Replacing the
 *   span the caret sits in is what makes a widget impossible to edit out.
 */
/**
 * True when the selection overlaps the interior of `[start, end)`.
 *
 * Exclusive ends matter: a caret sitting on either boundary (the usual place
 * after an arrow key steps past a pill) must not strip the decoration. Only a
 * real interior caret or a range that covers part of the token counts as
 * "editing this citation".
 */
function selectionOverlapsCitation(
  ranges: readonly { from: number; to: number }[],
  start: number,
  end: number,
): boolean {
  return ranges.some(
    (range) => range.from < end && range.to > start,
  );
}

export function citationLivePreview(host: PillHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      private legacy: DocumentLink[];
      private parsed?: { doc: DocText; links: DocumentLink[] };
      private timer?: number;

      constructor(private readonly view: EditorView) {
        this.legacy = this.scanLegacy();
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.legacy = mapDocumentLinks(this.legacy, update.changes);
          window.clearTimeout(this.timer);
          this.timer = window.setTimeout(() => this.rescan(), RESCAN_DELAY_MS);
        }
        const rescanned = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(legacyRescanned)));
        if (update.docChanged || update.viewportChanged || update.selectionSet || rescanned) {
          this.decorations = this.build(update.view);
        }
      }

      destroy(): void {
        window.clearTimeout(this.timer);
      }

      private rescan(): void {
        const hadLegacy = this.legacy.length > 0;
        this.legacy = this.scanLegacy();
        if (hadLegacy || this.legacy.length) { this.view.dispatch({ effects: legacyRescanned.of(null) }); }
      }

      private linksOf(doc: DocText, text: string): DocumentLink[] {
        if (this.parsed?.doc !== doc) { this.parsed = { doc, links: scanDocumentLinks(text) }; }
        return this.parsed.links;
      }

      private scanLegacy(): DocumentLink[] {
        const doc = this.view.state.doc, text = doc.toString();
        if (!scanCitations(text).length) { return []; }
        return this.linksOf(doc, text).filter((link) => link.legacy && link.target.kind === "paper");
      }

      /** The UniZero Markdown link at a position, for the event in hand. */
      linkAt(position: number): DocumentLink | undefined {
        const doc = this.view.state.doc, text = doc.toString();
        if (!text.includes("unizero://")) { return undefined; }
        return this.linksOf(doc, text).find((l) => !l.legacy && position >= l.from && position <= l.to);
      }

      private build(view: EditorView): DecorationSet {
        const ranges: Range<Decoration>[] = [];
        const selection = view.state.selection;

        for (const { from, to } of view.visibleRanges) {
          for (const link of this.legacy.filter((link) => link.from >= from && link.to <= to)) {
            if (link.target.kind !== "paper") { continue; }
            const token: CitationToken = { ...link.target, raw: link.raw, from: link.from, to: link.to };
            const start = link.from;
            const end = link.to;

            if (selectionOverlapsCitation(selection.ranges, start, end)) { continue; }
            if (isInertRange(view, start, end)) { continue; }

            ranges.push(Decoration.replace({
              widget: new CitationWidget(host, token),
            }).range(start, end));
          }
        }

        // RangeSetBuilder requires sorted input; visibleRanges are ordered, and
        // scanCitations returns matches in order, so a single pass suffices.
        const builder = new RangeSetBuilder<Decoration>();
        for (const range of ranges) {
          builder.add(range.from, range.to, range.value);
        }
        return builder.finish();
      }
    },
    {
      decorations: (value) => value.decorations,
      // Atomic ranges keep the caret from landing inside a pill's source span.
      // Combined with ignoreEvent, a left-click activates the pill instead of
      // collapsing it back to `@libraryID/itemKey`.
      provide: (p) => EditorView.atomicRanges.of((view) => {
        return view.plugin(p)?.decorations ?? Decoration.none;
      }),
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
