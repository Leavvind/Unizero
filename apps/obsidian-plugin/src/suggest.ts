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
import { citationPrefixAt, citationText, linkDestinationAt } from "./citation";
import type { BridgeSuggestion } from "./bridge";
import type UnizeroPlugin from "./main";
import type { NoteIdentity } from "./vaultIdentity";
import { markdownLink, paperLabel, serializeLinkTarget, type LinkTarget } from "./linkTarget";
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

/** Vault notes a plain `@` lists after the papers. */
const MIXED_NOTE_LIMIT = 5;

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
      if (hit && hit.kind !== "switch" && this.context === context) { void this.insert(hit, jump.next); }
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
    const source = /^(vault|zotero)(?:\s|$)/i.exec(text)?.[1].toLowerCase();
    const query = text.replace(/^(?:vault|zotero)\s*/i, "");
    const swap: Suggestion = { kind: "switch", to: source === "vault" ? "zotero" : "vault", query };
    const notes = (limit?: number) => this.plugin.identity.search(query, limit).map((note): Suggestion => ({ kind: "note", note }));
    // Last, so that a key always acts on the best hit rather than on this row.
    if (source === "vault") { return [...notes(), swap]; }
    const papers = (await this.library.search(query)).map((paper): Suggestion => ({ kind: "paper", paper }));
    // A plain `@` also lists the best Vault matches after the papers; `@zotero` does not.
    return [...papers, ...(source || !query ? [] : notes(MIXED_NOTE_LIMIT)), swap];
  }
  renderSuggestion(suggestion: Suggestion, element: HTMLElement): void {
    if (suggestion.kind === "switch") { element.setText(`Search ${suggestion.to === "vault" ? "Vault documents" : "Zotero papers"} instead…`); return; }
    if (suggestion.kind === "paper") { renderSuggestion(suggestion.paper, element); }
    else { element.createDiv({ text: suggestion.note.title }); element.createDiv({ cls: "unizero-suggestion__meta", text: `Vault · ${suggestion.note.path} · ${suggestion.note.uid || "no UID"}` }); }
  }
  selectSuggestion(suggestion: Suggestion, event: MouseEvent | KeyboardEvent): void {
    if (suggestion.kind === "switch") {
      const context = this.context; if (!context) { return; }
      context.editor.replaceRange(`@${suggestion.to} ${suggestion.query}`, context.start, context.end); return;
    }
    const key = "key" in event ? event.key : "";
    // `#` and `^` are shifted keys on most layouts, so they are checked first.
    void this.insert(suggestion, key === "#" ? "heading" : key === "^" ? "block" : event.shiftKey || key === "Tab" ? "target" : "none");
  }
  /** Inserts the chosen link; for a note without a UID it first asks for one. */
  private async insert(suggestion: Exclude<Suggestion, { kind: "switch" }>, next: Continue): Promise<void> {
    const context = this.context; if (!context) { return; }
    try {
      let target: LinkTarget, label: string;
      const { editor, file, start, end } = context;
      this.close();
      if (suggestion.kind === "paper") {
        target = { kind: "paper", libraryID: suggestion.paper.libraryID, itemKey: suggestion.paper.itemKey, action: "detail" };
        label = paperLabel(suggestion.paper);
      } else {
        const note = suggestion.note, typed = editor.getRange(start, end);
        let uid = note.uid;
        if (uid) {
          const result = this.plugin.identity.resolve(this.plugin.settings.vaultID, uid);
          if (result.status === "conflict") { new Notice(`UID conflict: ${result.notes.map((n) => n.path).join(", ")}`); return; }
        } else {
          // A note without a UID cannot be a stable target; give it a generated one.
          uid = await this.plugin.uidForLinking(note.path);
          if (!uid) { return; }
          // Assigning reads changed files first; insert only if the typed query is still in place.
          if (editor.getRange(start, end) !== typed) { new Notice("The text changed while the UID was being assigned; insert the link again."); return; }
        }
        target = { kind: "note", vaultID: this.plugin.settings.vaultID, uid }; label = note.title;
      }
      const raw = target.kind === "paper" && next !== "target" && next !== "none" ? ".md" : "";
      const fragment = next === "heading" ? "#" : next === "block" ? "#^" : "";
      const destination = linkDestinationAt(editor.getLine(start.line), start.ch, end.ch);
      if (destination && destination.emptyLabelAt === undefined) {
        // `[label](@query)`: the label is the user's; write only the URL.
        const uri = `${serializeLinkTarget(target)}${raw}${fragment}`;
        editor.replaceRange(uri, start, end);
        editor.setCursor({ line: start.line, ch: start.ch + uri.length + (next === "none" ? 1 : 0) });
        if (next !== "none") { openSuggestions(this.app, editor, file); }
        return;
      }
      // `[](@query)` is replaced whole, label included.
      const from = destination ? { line: start.line, ch: destination.emptyLabelAt! } : start;
      const to = destination ? { line: end.line, ch: end.ch + 1 } : end;
      if (next === "none") { editor.replaceRange(markdownLink(label, target), from, to); return; }
      const link = `${markdownLink(label, target).slice(0, -1)}${raw}${fragment})`;
      editor.replaceRange(link, from, to);
      editor.setCursor({ line: from.line, ch: from.ch + link.length - 1 });
      openSuggestions(this.app, editor, file);
    } catch (error) { this.plugin.reportError(error); }
  }
}
