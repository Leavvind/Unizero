/**
 * Completion inside a UniZero link destination, the way `[[` completes inside a wikilink:
 * attachment, then heading, block or page. Reads only what the user is completing and
 * never starts a conversion or a provider request.
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
import { readFile } from "fs/promises";
import { textAnchors, type TextAnchor } from "./documentLinks";
import {
  caretAfter, completionAt, locationChoices, markdownLocationChoices, pageChoices, targetChoices,
  type CompletionChoice, type LinkCompletion,
} from "./linkCompletion";
import { serializeLinkTarget, type LinkTarget } from "./linkTarget";
import type { BridgeArtifacts } from "./bridge";
import type { PaperRef } from "./citation";
import type UnizeroPlugin from "./main";

/** A document is parsed once while the user filters its headings. */
const CACHE_MS = 30000;

/**
 * Obsidian opens a suggester by itself only for typed text, so continuing after a
 * programmatic insertion goes through its manager. It is not public API; without it the
 * popup simply waits for the next keystroke.
 */
export function openSuggestions(app: App, editor: Editor, file: TFile | null): void {
  (app.workspace as unknown as { editorSuggest?: { trigger?(editor: Editor, file: TFile | null, open: boolean): void } })
    .editorSuggest?.trigger?.(editor, file, true);
}

export class LinkTargetSuggest extends EditorSuggest<CompletionChoice> {
  private cached?: { key: string; expires: number; anchors: Promise<TextAnchor[]> };
  private cachedFiles?: { key: string; expires: number; files: Promise<BridgeArtifacts> };
  private lastNotice?: { message: string; at: number };

  constructor(app: App, private readonly plugin: UnizeroPlugin) {
    super(app);
    this.setInstructions([{ command: "↵", purpose: "choose" }, { command: "type", purpose: "filter" }, { command: "esc", purpose: "keep the link as written" }]);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const completion = completionAt(editor.getLine(cursor.line), cursor.ch);
    return completion ? { start: { line: cursor.line, ch: completion.from }, end: { line: cursor.line, ch: completion.to }, query: "" } : null;
  }

  async getSuggestions(context: EditorSuggestContext): Promise<CompletionChoice[]> {
    const cursor = context.editor.getCursor();
    const completion = completionAt(context.editor.getLine(cursor.line), cursor.ch);
    if (!completion) { return []; }
    try {
      if (completion.stage === "page") { return pageChoices(completion); }
      if (completion.stage === "location") {
        if (completion.target.kind === "paper" && !completion.target.attachmentKey) {
          const choices = markdownLocationChoices(await this.files(completion.target), completion.fragment);
          if (choices) { return choices; }
        }
        return locationChoices(await this.anchors(completion.target), completion.fragment);
      }
      return targetChoices(await this.files(completion.ref), completion.query);
    } catch (error) {
      // Each keystroke asks again; an unchanged failure is reported once, not per key.
      const message = `UniZero: ${(error as Error).message}`;
      if (this.lastNotice?.message !== message || this.lastNotice.at + CACHE_MS < Date.now()) {
        this.lastNotice = { message, at: Date.now() };
        new Notice(message);
      }
      return [];
    }
  }

  renderSuggestion(choice: CompletionChoice, element: HTMLElement): void {
    element.addClasses(["unizero-suggestion", "unizero-choice"]);
    if (choice.level) { element.createSpan({ cls: "unizero-choice__level", text: `H${choice.level}` }); }
    const label = element.createSpan({ cls: "unizero-choice__label", text: choice.label });
    if (choice.level) { label.style.setProperty("--unizero-indent", String(choice.level - 1)); }
    if (choice.detail) { element.createSpan({ cls: "unizero-choice__detail", text: choice.detail }); }
  }

  selectSuggestion(choice: CompletionChoice): void {
    const context = this.context;
    if (!context) { return; }
    const { editor, file } = context, line = context.start.line;
    const completion: LinkCompletion | undefined = completionAt(editor.getLine(line), editor.getCursor().ch);
    if (!completion) { return; }
    this.close();
    editor.replaceRange(choice.text, { line, ch: completion.from }, { line, ch: completion.to });
    editor.setCursor({ line, ch: caretAfter(completion, choice) });
    if (choice.next) { openSuggestions(this.app, editor, file); }
  }

  /** A paper's attachments, fetched once while the user filters them. */
  private files(ref: PaperRef): Promise<BridgeArtifacts> {
    const key = `${ref.libraryID}/${ref.itemKey}`;
    if (this.cachedFiles?.key === key && this.cachedFiles.expires > Date.now()) { return this.cachedFiles.files; }
    const files = this.plugin.bridge.artifacts(ref);
    this.cachedFiles = { key, expires: Date.now() + CACHE_MS, files };
    files.catch(() => { if (this.cachedFiles?.key === key) { this.cachedFiles = undefined; } });
    return files;
  }

  private anchors(target: LinkTarget): Promise<TextAnchor[]> {
    const key = serializeLinkTarget(target);
    if (this.cached?.key === key && this.cached.expires > Date.now()) { return this.cached.anchors; }
    const anchors = this.readDocument(target).then(textAnchors);
    this.cached = { key, expires: Date.now() + CACHE_MS, anchors };
    anchors.catch(() => { if (this.cached?.key === key) { this.cached = undefined; } });
    return anchors;
  }

  private async readDocument(target: LinkTarget): Promise<string> {
    if (target.kind === "paper") {
      const resolved = await this.plugin.bridge.linkTarget(target, "markdown", target.attachmentKey);
      if (!resolved.source?.path) { throw new Error("This Markdown attachment is not available on this machine."); }
      return readFile(resolved.source.path, "utf8");
    }
    const result = this.plugin.identity.resolve(target.vaultID, target.uid);
    if (result.status !== "found") { throw new Error(`Document identity is ${result.status}.`); }
    return this.plugin.app.vault.adapter.read(result.notes[0].path);
  }
}
