/**
 * `@` completion backed by the Zotero library.
 *
 * `EditorSuggest` is public Obsidian API and works in every Markdown editor,
 * which includes canvas text nodes — the same reason the renderers need no canvas
 * knowledge applies here.
 */

import {
  EditorSuggest,
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

const SUGGEST_LIMIT = 20;

export class CitationSuggest extends EditorSuggest<BridgeSuggestion> {
  constructor(app: App, private readonly plugin: UnizeroPlugin) {
    super(app);
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null,
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const prefix = citationPrefixAt(line, cursor.ch);
    if (!prefix) { return null; }

    return {
      start: { line: cursor.line, ch: prefix.start },
      end: cursor,
      query: prefix.query,
    };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<BridgeSuggestion[]> {
    try {
      return await this.plugin.bridge.suggest(context.query, SUGGEST_LIMIT);
    } catch {
      // A closed popup is the right answer when Zotero is not running. The pill
      // for whatever the user types anyway will report the failure with room to
      // explain it; a suggester cannot.
      return [];
    }
  }

  renderSuggestion(suggestion: BridgeSuggestion, element: HTMLElement): void {
    element.addClass("unizero-suggestion");
    element.createDiv({ cls: "unizero-suggestion__key", text: `@${suggestion.citekey}` });
    element.createDiv({ cls: "unizero-suggestion__title", text: suggestion.title });

    const meta = [
      suggestion.authors.slice(0, 3).join(", ") +
        (suggestion.authors.length > 3 ? " et al." : ""),
      suggestion.year,
    ].filter(Boolean).join(" · ");
    if (meta) {
      element.createDiv({ cls: "unizero-suggestion__meta", text: meta });
    }
  }

  selectSuggestion(suggestion: BridgeSuggestion): void {
    const context = this.context;
    if (!context) { return; }
    context.editor.replaceRange(
      citationText(suggestion.citekey),
      context.start,
      context.end,
    );
  }
}
