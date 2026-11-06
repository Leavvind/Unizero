/**
 * `@` completion backed by the Zotero library.
 *
 * The query is free text (author, title, year, citekey fragment), including
 * spaces. Selecting a hit inserts a Markdown UniZero link, optionally continuing
 * into its attachment, heading or block in `targetSuggest`, as `[[` does.
 *
 * `EditorSuggest` is public Obsidian API and works in every Markdown editor.
 */

import {
  EditorSuggest,
  Notice,
  type App,
  type Editor,
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  type TFile,
} from "obsidian";
import { citationPrefixAt, citationText } from "./citation";
import type { BridgeSuggestion } from "./bridge";
import type UnizeroPlugin from "./main";
import type { NoteIdentity } from "./vaultIdentity";
import { markdownLink, paperLabel, type LinkTarget } from "./linkTarget";
import { jumpAt } from "./linkCompletion";
import { openSuggestions } from "./targetSuggest";

const SUGGEST_LIMIT = 20;
/**
 * Quiet time before a query goes to Zotero. Its HTTP server is single-threaded,
 * and every keystroke of `@acemoglu` would otherwise be a full-library search.
 */
const SUGGEST_DEBOUNCE_MS = 150;

/**
 * Free-text library search, debounced: a call superseded within the quiet period
 * resolves with the newer query's results rather than sending its own request.
 */
export class LibrarySearch {
  /** Calls waiting for the current quiet period; all get the latest query's result. */
  private waiting: ((suggestions: BridgeSuggestion[]) => void)[] = [];
  private timer?: number;

  constructor(private readonly plugin: UnizeroPlugin) {
    plugin.register(() => { window.clearTimeout(this.timer); for (const done of this.waiting) { done([]); } this.waiting = []; });
  }

  search(query: string): Promise<BridgeSuggestion[]> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        const batch = this.waiting;
        this.waiting = [];
        this.timer = undefined;
        void this.request(query).then((suggestions) => {
          for (const done of batch) { done(suggestions); }
        });
      }, SUGGEST_DEBOUNCE_MS);
    });
  }

  private async request(query: string): Promise<BridgeSuggestion[]> {
    try {
      return await this.plugin.bridge.suggest(query, SUGGEST_LIMIT);
    } catch {
      // A closed popup is the right answer when Zotero is not running; opening
      // a link reports the failure with room to explain it, a suggester cannot.
      return [];
    }
  }
}

/** Title, then authors, year and citekey on one line. */
export function renderSuggestion(suggestion: BridgeSuggestion, element: HTMLElement): void {
  element.addClass("unizero-suggestion");
  element.createDiv({ cls: "unizero-suggestion__title", text: suggestion.title });

  const handle = `@${suggestion.libraryID}/${suggestion.itemKey}`;
  const meta = [
    suggestion.authors.slice(0, 3).join(", ") +
      (suggestion.authors.length > 3 ? " et al." : ""),
    suggestion.year,
    suggestion.citekey,
  ].filter(Boolean).join(" · ");
  element.createDiv({ cls: "unizero-suggestion__meta", text: meta || handle });
  element.title = handle;
}

type Suggestion = { kind: "switch"; to: "vault" | "zotero"; query: string }
  | { kind: "paper"; paper: BridgeSuggestion } | { kind: "note"; note: NoteIdentity };
/** How far a selection goes: finish the link, or stay inside it for what comes next. */
type Continue = "none" | "target" | "heading" | "block";

/** The suggester's list. Not public API, though Obsidian's own `[[` uses it the same way. */
interface Chooser { useSelectedItem(event: KeyboardEvent): boolean; getSelectedValue(): Suggestion | null }

export class CitationSuggest extends EditorSuggest<Suggestion> {
  private readonly library: LibrarySearch;
  /** The query whose results the popup shows, which lags behind fast typing. */
  private shownQuery?: string;
  constructor(app: App, private readonly plugin: UnizeroPlugin) {
    super(app); this.library = new LibrarySearch(plugin);
    this.setInstructions([{ command: "↵", purpose: "insert link" }, { command: "tab", purpose: "choose Raw or PDF" }, { command: "#", purpose: "heading" }, { command: "^", purpose: "block" }]);
    // The default list binds only an unmodified Enter.
    const choose = (event: KeyboardEvent) => {
      const list = this.list;
      if (event.isComposing || list.getSelectedValue()?.kind === "switch") { return; }
      return list.useSelectedItem(event) ? false : undefined;
    };
    this.scope.register(["Shift"], "Enter", choose);
    this.scope.register([], "Tab", choose);
    this.scope.register(null, "#", choose);
    this.scope.register(null, "^", choose);
  }
  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const prefix = citationPrefixAt(editor.getLine(cursor.line), cursor.ch);
    return prefix ? { start: { line: cursor.line, ch: prefix.start }, end: cursor, query: prefix.query } : null;
  }
  async getSuggestions(context: EditorSuggestContext): Promise<Suggestion[]> {
    const jump = jumpAt(context.query);
    if (jump) {
      // A key the scope could not see: an IME wrote `#` or `^` into the query instead.
      const selected = this.popupOpen && this.shownQuery === jump.query ? this.list.getSelectedValue() : null;
      const hit = await (selected && selected.kind !== "switch" ? selected : this.hits(jump.query).then((hits) => hits[0]));
      // The `await` also leaves the editor update that called this, so editing is safe.
      if (hit && hit.kind !== "switch" && this.context === context) { this.insert(hit, jump.next); }
      return [];
    }
    const hits = await this.hits(context.query);
    this.shownQuery = context.query;
    return hits;
  }
  private get list(): Chooser { return (this as unknown as { suggestions: Chooser }).suggestions; }
  /** Named apart from `isOpen`: the base constructor assigns that, so an accessor there would throw. */
  private get popupOpen(): boolean { return (this as unknown as { isOpen: boolean }).isOpen; }
  private async hits(text: string): Promise<Suggestion[]> {
    const vault = /^vault(?:\s|$)/i.test(text);
    const query = text.replace(/^(?:vault|zotero)\s*/i, "");
    const swap: Suggestion = { kind: "switch", to: vault ? "zotero" : "vault", query };
    // Last, so that a key always acts on the best hit rather than on this row.
    if (vault) { return [...this.plugin.identity.search(query).map((note): Suggestion => ({ kind: "note", note })), swap]; }
    return [...(await this.library.search(query)).map((paper): Suggestion => ({ kind: "paper", paper })), swap];
  }
  renderSuggestion(suggestion: Suggestion, element: HTMLElement): void {
    if (suggestion.kind === "switch") { element.setText(`Search ${suggestion.to === "vault" ? "Vault documents" : "Zotero papers"} instead…`); return; }
    if (suggestion.kind === "paper") { renderSuggestion(suggestion.paper, element); }
    else { element.createDiv({ text: suggestion.note.title }); element.createDiv({ cls: "unizero-suggestion__meta", text: `${suggestion.note.path} · ${suggestion.note.uid || "no UID"}` }); }
  }
  selectSuggestion(suggestion: Suggestion, event: MouseEvent | KeyboardEvent): void {
    if (suggestion.kind === "switch") {
      const context = this.context; if (!context) { return; }
      context.editor.replaceRange(`@${suggestion.to} ${suggestion.query}`, context.start, context.end); return;
    }
    const key = "key" in event ? event.key : "";
    // `#` and `^` are shifted keys on most layouts, so they are checked first.
    this.insert(suggestion, key === "#" ? "heading" : key === "^" ? "block" : event.shiftKey || key === "Tab" ? "target" : "none");
  }
  private insert(suggestion: Exclude<Suggestion, { kind: "switch" }>, next: Continue): void {
    const context = this.context; if (!context) { return; }
    try {
      let target: LinkTarget, label: string;
      if (suggestion.kind === "paper") {
        target = { kind: "paper", libraryID: suggestion.paper.libraryID, itemKey: suggestion.paper.itemKey, action: "detail" };
        label = paperLabel(suggestion.paper);
      } else {
        const note = suggestion.note;
        if (!note.uid) { new Notice("This document needs a UID before it can be a stable target. Use Set current document UID or your existing generator."); return; }
        const result = this.plugin.identity.resolve(this.plugin.settings.vaultID, note.uid);
        if (result.status !== "found") { new Notice(`UID conflict: ${result.notes.map((n) => n.path).join(", ")}`); return; }
        target = { kind: "note", vaultID: this.plugin.settings.vaultID, uid: note.uid }; label = note.title;
      }
      const { editor, file, start, end } = context;
      this.close();
      if (next === "none") { editor.replaceRange(markdownLink(label, target), start, end); return; }
      const raw = target.kind === "paper" && next !== "target" ? ".md" : "";
      const fragment = next === "heading" ? "#" : next === "block" ? "#^" : "";
      const link = `${markdownLink(label, target).slice(0, -1)}${raw}${fragment})`;
      editor.replaceRange(link, start, end);
      editor.setCursor({ line: start.line, ch: start.ch + link.length - 1 });
      openSuggestions(this.app, editor, file);
    } catch (error) { this.plugin.reportError(error); }
  }
}
