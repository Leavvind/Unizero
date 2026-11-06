import { debounce, ItemView, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type UnizeroPlugin from "./main";
import type { LinkOccurrence } from "./linkIndex";
import { occurrenceSnippet } from "./documentLinks";
import { openLinkOccurrence, openNativeBacklink } from "./linkOpening";
import { nativeBacklinks, type NativeBacklink, type NativeLinkForm } from "./nativeLinks";
import { describeTarget, markdownLink, serializeLinkTarget } from "./linkTarget";
import { excludedSpans, findMentions, mentionSnippet, type Mention } from "./unlinkedMentions";

export const BACKLINKS_VIEW_TYPE = "unizero-backlinks";
/** Index state, including scan problems, for Settings only; the panes stay quiet and rely on automatic refresh. */
export function coverageSummary(plugin: UnizeroPlugin): string {
  const index = plugin.vaultIndex.links, c = index.coverage;
  const scanned = c.lastSuccess ? new Date(c.lastSuccess).toLocaleString() : "";
  return [`Vault ${index.vaultState}`, plugin.settings.indexZoteroSources ? `Zotero ${c.state}` : "Zotero documents not indexed",
    c.unavailable ? `${c.unavailable} Zotero document${c.unavailable === 1 ? "" : "s"} could not be read` : "", scanned ? `last Zotero scan ${scanned}` : "", c.error || ""].filter(Boolean).join(" · ");
}
/** Target notes whose mentions each source keeps cached. */
const MENTION_TERM_SETS = 8;
const FORM_LABEL:Record<NativeLinkForm, string> = { wikilink: "wikilink", embed: "embed", markdown: "Markdown", property: "property", file: "linked" };
type Row = { kind: "unizero"; occurrence: LinkOccurrence } | { kind: "native"; link: NativeBacklink };
const rowSource = (row: Row) => row.kind === "native" ? row.link.sourcePath : row.occurrence.source.kind === "zotero"
  ? `${row.occurrence.source.libraryID}/${row.occurrence.source.itemKey}/${row.occurrence.source.attachmentKey}` : row.occurrence.source.path;
const rowLine = (row: Row) => row.kind === "native" ? row.link.line ?? -1 : row.occurrence.line;
const basename = (path: string) => path.split("/").pop()!.replace(/\.(md|canvas)$/, "");

function renderRow(box: HTMLElement, plugin: UnizeroPlugin, row: Row, showForm: boolean): void {
  const el = box.createDiv({ cls: "unizero-link-occurrence", attr: { role: "button", tabindex: "0" } });
  let open: () => Promise<void>;
  if (row.kind === "unizero") {
    const occurrence = row.occurrence;
    el.title = serializeLinkTarget(occurrence.target);
    const meta = el.createSpan({ cls: "unizero-link-occurrence__line" });
    if (showForm) { meta.createSpan({ cls: "unizero-link-occurrence__form is-unizero", text: "UniZero" }); }
    meta.appendText(`${occurrence.stale ? "stale " : ""}${occurrence.nodeId ? `Card ${occurrence.nodeId} ` : ""}L${occurrence.line + 1}`);
    el.createSpan({ cls: "unizero-link-occurrence__text", text: occurrenceSnippet(occurrence.lineText, occurrence.ch) });
    const target = describeTarget(occurrence.target);
    if (target) { el.createSpan({ cls: "unizero-link-occurrence__target", text: target }); }
    open = () => openLinkOccurrence(plugin, occurrence);
  } else {
    const link = row.link;
    el.title = link.raw || `${link.sourcePath} links here`;
    const meta = el.createSpan({ cls: "unizero-link-occurrence__line" });
    meta.createSpan({ cls: "unizero-link-occurrence__form", text: FORM_LABEL[link.form] });
    if (link.line !== undefined) { meta.appendText(`L${link.line + 1}`); }
    const text = link.form === "property" ? `${link.key?.replace(/\.\d+$/, "")}: ${link.raw}` : link.form === "file"
      ? `${link.count} link${link.count === 1 ? "" : "s"}, position not available`
      : link.lineText !== undefined ? occurrenceSnippet(link.lineText, link.ch!) : link.raw!;
    el.createSpan({ cls: "unizero-link-occurrence__text", text });
    if (link.subpath) { el.createSpan({ cls: "unizero-link-occurrence__target", text: `#${link.subpath}` }); }
    open = () => openNativeBacklink(plugin, link);
  }
  const run = () => { void open().catch((error) => plugin.reportError(error)); };
  el.onclick = run;
  el.onkeydown = (event) => { if (event.key === "Enter") { run(); } };
}

/** `native` lists Obsidian's own links into a Vault note; pass it only where those apply. */
export function renderOccurrences(container: HTMLElement, plugin: UnizeroPlugin, occurrences: LinkOccurrence[], native?: NativeBacklink[]): void {
  const rows: Row[] = [...occurrences.map((occurrence) => ({ kind: "unizero" as const, occurrence })),
    ...(native || []).map((link) => ({ kind: "native" as const, link }))];
  const showForm = native !== undefined;
  for (const kind of ["zotero", "vault"] as const) {
    const links = rows.filter((row) => row.kind === "native" ? kind === "vault" : row.occurrence.source.kind === kind);
    if (!links.length) { continue; }
    container.createDiv({ cls: "unizero-links__section", text: `${kind === "zotero" ? "Zotero" : "Vault"} (${links.length})` });
    const groups = new Map<string, Row[]>();
    for (const row of links) { const key = rowSource(row), group = groups.get(key) || []; group.push(row); groups.set(key, group); }
    const keys = [...groups.keys()];
    if (kind === "vault") { keys.sort((a, b) => a.localeCompare(b)); }
    for (const key of keys) {
      const group = groups.get(key)!.sort((a, b) => rowLine(a) - rowLine(b));
      const first = group[0], box = container.createDiv({ cls: "unizero-links__group" });
      const header = box.createDiv({ cls: "unizero-links__source" });
      if (first.kind === "unizero" && first.occurrence.source.kind === "zotero") {
        const source = first.occurrence.source;
        header.title = `${source.purpose} · ${source.path || "File unavailable"}`;
        header.createEl("a", { cls: "unizero-links__name", text: source.itemTitle }).onclick = () => { void plugin.showInDetailView(source); };
        header.createSpan({ cls: "unizero-links__file", text: source.title });
      } else {
        const unizero = group.find((row) => row.kind === "unizero");
        header.title = key;
        header.createSpan({ cls: "unizero-links__name", text: unizero?.kind === "unizero" ? unizero.occurrence.source.title : basename(key) });
      }
      if (group.length > 1) { header.createSpan({ cls: "unizero-links__count", text: String(group.length) }); }
      for (const row of group) { renderRow(box, plugin, row, showForm); }
    }
  }
}
export class BacklinksView extends ItemView {
  private unsubscribe?: () => void;
  private generation = 0;
  /** Unlinked mentions are read from every Vault note, so only while the section is open. */
  private mentionsOpen = false;
  /**
   * Per source note, valid while it is unchanged: its excluded spans, which do not
   * depend on the target, and its mentions for the last few target notes, so moving
   * between notes does not rescan the Vault.
   */
  private readonly mentionCache = new Map<string, { mtime: number; spans?: Array<[number, number]>; byTerms: Map<string, Mention[]> }>();
  /** Mention sources the user expanded, for the note in `mentionTarget`. */
  private readonly expandedMentions = new Set<string>();
  private mentionTarget?: string;
  /**
   * Native links into the shown note, kept until a change that can alter them, so
   * index notifications and toggles do not reread their sources. `nativeVersion`
   * bumps on every such change, so a lookup that raced one is not kept.
   */
  private nativeCache?: { path: string; links: NativeBacklink[]; sources: Set<string> };
  private nativeVersion = 0;
  /** A render was skipped while the pane was hidden; it runs when the pane shows. */
  private stale = false;
  private readonly scheduleRender = debounce(() => {
    if (!this.contentEl.isShown()) { this.stale = true; return; }
    void this.render();
  }, 300, true);
  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnizeroPlugin) { super(leaf); }
  getViewType(): string { return BACKLINKS_VIEW_TYPE; }
  getDisplayText(): string { return "UniZero Backlinks"; }
  getIcon(): string { return "links-coming-in"; }
  async onOpen(): Promise<void> {
    // Index passes and native resolution both arrive in bursts while typing; each render reads source files.
    this.unsubscribe = this.plugin.vaultIndex.links.subscribe(() => this.scheduleRender());
    // Obsidian re-resolves one file at a time after an edit; only some files bear on this pane.
    this.registerEvent(this.app.metadataCache.on("resolve", (file) => this.sourceChanged(file.path)));
    this.registerEvent(this.app.metadataCache.on("deleted", (file) => this.sourceChanged(file.path)));
    this.registerEvent(this.app.vault.on("rename", () => { this.invalidateNative(); this.scheduleRender(); }));
    // A sidebar tab coming back into view catches up on what it skipped.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.showIfStale()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.showIfStale()));
    await this.render();
  }
  onResize(): void { this.showIfStale(); }
  async onClose(): Promise<void> { this.unsubscribe?.(); this.scheduleRender.cancel(); this.generation++; this.mentionCache.clear(); this.invalidateNative(); }
  private showIfStale(): void {
    if (this.stale && this.contentEl.isShown()) { this.stale = false; void this.render(); }
  }
  /** Notes already read ahead of the Vault index, so a failed read is not retried on every render. */
  private readonly indexedAhead = new Set<string>();
  private indexAhead(file: TFile): void {
    if (this.indexedAhead.has(file.path)) { return; }
    this.indexedAhead.add(file.path);
    // Indexing notifies only when the note's links change, so render here as well.
    void this.plugin.vaultIndex.indexFile(file).then(() => this.scheduleRender(), (error) => this.plugin.reportError(error));
  }
  private invalidateNative(): void { this.nativeCache = undefined; this.nativeVersion++; }
  /**
   * A note changed. Native links change only if it links or linked to the shown
   * note; with mentions open, any note may mention it, and the shown note's own
   * aliases are its terms. Its UID reaches the pane through the link index.
   */
  private sourceChanged(path: string): void {
    const current = this.plugin.currentDocument?.path;
    if (!current) { return; }
    const native = path !== current && (this.nativeCache?.sources.has(path) || (this.app.metadataCache.resolvedLinks[path]?.[current] || 0) > 0);
    if (native) { this.invalidateNative(); }
    if (native || this.mentionsOpen) { this.scheduleRender(); }
  }
  /** The title and frontmatter aliases a mention may use. */
  private mentionTerms(file: TFile): string[] {
    const aliases: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
    const list: unknown[] = Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [];
    return [file.basename, ...list.filter((alias): alias is string => typeof alias === "string")];
  }
  /** Unlinked mentions of `file` in other Vault notes, by source path. Zotero documents are not read. */
  private async unlinkedMentions(file: TFile): Promise<Array<{ path: string; mentions: Mention[] }>> {
    const terms = this.mentionTerms(file), key = JSON.stringify(terms), { vault } = this.app;
    const sources = vault.getMarkdownFiles().filter((source) => source.path !== file.path);
    const live = new Set(sources.map((source) => source.path));
    for (const path of this.mentionCache.keys()) { if (!live.has(path)) { this.mentionCache.delete(path); } }
    const found = await Promise.all(sources.map(async (source) => {
      let entry = this.mentionCache.get(source.path);
      if (entry?.mtime !== source.stat.mtime) { entry = { mtime: source.stat.mtime, byTerms: new Map() }; this.mentionCache.set(source.path, entry); }
      const cached = entry.byTerms.get(key);
      if (cached) { return { path: source.path, mentions: cached }; }
      const text = await vault.cachedRead(source), current = entry;
      const mentions = findMentions(text, terms, () => current.spans ??= excludedSpans(text));
      if (current.byTerms.size >= MENTION_TERM_SETS) { current.byTerms.delete(current.byTerms.keys().next().value!); }
      current.byTerms.set(key, mentions);
      return { path: source.path, mentions };
    }));
    return found.filter((entry) => entry.mentions.length).sort((a, b) => a.path.localeCompare(b.path));
  }
  /** Turns one mention into a UniZero link to `file`, giving `file` a UID first if it has none. */
  private async linkMention(file: TFile, path: string, mention: Mention): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(path);
    if (!(source instanceof TFile)) { throw new Error("The source document is missing."); }
    const uid = await this.plugin.setDocumentUID(file);
    if (!uid) { return; }
    const link = markdownLink(mention.text, { kind: "note", vaultID: this.plugin.settings.vaultID, uid });
    let changed = false;
    await this.app.vault.process(source, (text) => {
      if (text.slice(mention.from, mention.to) !== mention.text) { changed = true; return text; }
      return text.slice(0, mention.from) + link + text.slice(mention.to);
    });
    if (changed) { new Notice("The note changed since the mentions were listed; try again."); }
    this.scheduleRender();
  }
  private renderMentions(body: HTMLElement, file: TFile, found: Array<{ path: string; mentions: Mention[] }> | undefined): void {
    // Expanded sources belong to one target note; another note starts all collapsed.
    if (this.mentionTarget !== file.path) { this.mentionTarget = file.path; this.expandedMentions.clear(); }
    const total = found?.reduce((sum, entry) => sum + entry.mentions.length, 0);
    const header = body.createDiv({ cls: "unizero-links__section unizero-links__toggle", attr: { role: "button", tabindex: "0" } });
    setIcon(header.createSpan({ cls: "unizero-links__chevron" }), this.mentionsOpen ? "chevron-down" : "chevron-right");
    header.createSpan({ text: "Unlinked mentions" });
    if (total !== undefined) { header.createSpan({ cls: "unizero-links__count", text: String(total) }); }
    const toggle = () => { this.mentionsOpen = !this.mentionsOpen; void this.render(); };
    header.onclick = toggle;
    header.onkeydown = (event) => { if (event.key === "Enter") { toggle(); } };
    if (!this.mentionsOpen || !found) { return; }
    for (const { path, mentions } of found) {
      // Each source starts collapsed, as a title count; its rows are built on first expansion.
      const box = body.createDiv({ cls: "unizero-links__group unizero-mention-group" });
      const source = box.createDiv({ cls: "unizero-links__source unizero-links__toggle", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
      source.title = path;
      const chevron = source.createSpan({ cls: "unizero-links__chevron" });
      source.createSpan({ cls: "unizero-links__name", text: basename(path) });
      source.createSpan({ cls: "unizero-links__count", text: String(mentions.length) });
      let rows: HTMLElement | undefined;
      const show = (open: boolean) => {
        setIcon(chevron, open ? "chevron-down" : "chevron-right");
        source.setAttr("aria-expanded", String(open));
        if (open && !rows) { rows = box.createDiv(); for (const mention of mentions) { this.renderMention(rows, file, path, mention); } }
        rows?.toggleClass("is-hidden", !open);
      };
      const flip = () => {
        const open = !this.expandedMentions.has(path);
        if (open) { this.expandedMentions.add(path); } else { this.expandedMentions.delete(path); }
        show(open);
      };
      source.onclick = flip;
      source.onkeydown = (event) => { if (event.key === "Enter") { flip(); } };
      show(this.expandedMentions.has(path));
    }
  }
  private renderMention(box: HTMLElement, file: TFile, path: string, mention: Mention): void {
    const el = box.createDiv({ cls: "unizero-link-occurrence unizero-mention", attr: { role: "button", tabindex: "0" } });
    el.createSpan({ cls: "unizero-link-occurrence__line", text: `L${mention.line + 1}` });
    const snippet = mentionSnippet(mention.lineText, mention.ch, mention.text.length);
    const text = el.createSpan({ cls: "unizero-link-occurrence__text" });
    text.appendText(snippet.before);
    text.createEl("mark", { cls: "unizero-mention__match", text: snippet.match });
    text.appendText(snippet.after);
    const link = el.createEl("button", { cls: "unizero-mention__link", text: "Link" });
    link.title = `Replace "${mention.text}" with a UniZero link to ${file.basename}`;
    link.onclick = (event) => { event.stopPropagation(); void this.linkMention(file, path, mention).catch((error) => this.plugin.reportError(error)); };
    const open = () => { void openNativeBacklink(this.plugin, { sourcePath: path, line: mention.line }).catch((error) => this.plugin.reportError(error)); };
    el.onclick = open;
    el.onkeydown = (event) => { if (event.key === "Enter" && event.target === el) { open(); } };
  }
  private async nativeLinks(file: TFile): Promise<NativeBacklink[]> {
    if (this.nativeCache?.path === file.path) { return this.nativeCache.links; }
    const { metadataCache, vault } = this.app, version = this.nativeVersion;
    const links = await nativeBacklinks({
      resolvedLinks: metadataCache.resolvedLinks,
      fileCache: (path) => metadataCache.getCache(path),
      resolve: (linkpath, sourcePath) => metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path,
      read: async (path) => { const source = vault.getAbstractFileByPath(path); return source instanceof TFile ? vault.cachedRead(source) : undefined; },
    }, file.path);
    if (version === this.nativeVersion) { this.nativeCache = { path: file.path, links, sources: new Set(links.map((link) => link.sourcePath)) }; }
    return links;
  }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    const external = this.plugin.currentExternal || (this.plugin.externalDocumentPath ? this.plugin.externalIndex?.findPath(this.plugin.externalDocumentPath) : undefined);
    const file = this.plugin.currentDocument;
    const native = !external && !this.plugin.externalDocumentPath && file ? await this.nativeLinks(file).catch((error) => {
      console.error("UniZero native backlinks", error); return undefined;
    }) : undefined;
    const mentions = this.mentionsOpen && native && file ? await this.unlinkedMentions(file).catch((error) => {
      console.error("UniZero unlinked mentions", error); return undefined;
    }) : undefined;
    // A newer render started while this one read source files.
    if (generation !== this.generation) { return; }
    const body = this.contentEl; body.empty();
    if (external?.kind === "zotero") {
      // A Zotero attachment such as Raw: list the links into its paper.
      const header = body.createDiv({ cls: "unizero-links__paper" });
      header.createEl("button", { text: "Item pane" }).onclick = () => { void this.plugin.showInDetailView(external); };
      renderOccurrences(body, this.plugin, this.plugin.vaultIndex.links.query({ kind: "paper", libraryID: external.libraryID, itemKey: external.itemKey, action: "detail" }));
      return;
    }
    if (this.plugin.externalDocumentPath) {
      body.createDiv({ cls: "unizero-links__notice", text: this.plugin.settings.indexZoteroSources
        ? "This document is not in the scanned Zotero sources yet."
        : "Turn on Index Zotero documents in Settings to list links for this document." });
      return;
    }
    if (!file) { body.createEl("p", { text: "Open a Vault Markdown document." }); return; }
    if (!native) { body.createDiv({ cls: "unizero-links__notice", text: "Obsidian links could not be read; see the developer console." }); }
    // Native links need no UID; UniZero links do. A missing or conflicting UID hides only the latter.
    const note = this.plugin.identity.get(file.path);
    let occurrences: LinkOccurrence[] = [];
    if (!note && this.plugin.vaultIndex.links.vaultState !== "complete") {
      // Not read yet: after a restart the Vault index runs in the background, so the
      // shown note is read ahead of it rather than reported as having no UID.
      body.createDiv({ cls: "unizero-links__notice", text: "Reading this document's UID…" });
      this.indexAhead(file);
    } else if (!note?.uid) {
      const notice = body.createDiv({ cls: "unizero-links__notice", text: `${note?.error || "This document has no stable identity."} UniZero links to it are not listed.` });
      notice.createEl("button", { text: "Assign UID" }).onclick = () => { void this.plugin.assignDocumentUID(); };
    } else {
      const resolution = this.plugin.identity.resolve(this.plugin.settings.vaultID, note.uid);
      if (resolution.status === "conflict") {
        body.createDiv({ cls: "unizero-links__notice", text: `UID conflict: ${resolution.notes.map((n) => n.path).join(", ")}. UniZero links to it are not listed.` });
      } else {
        occurrences = this.plugin.vaultIndex.links.query({ kind: "note", vaultID: this.plugin.settings.vaultID, uid: note.uid });
      }
    }
    renderOccurrences(body, this.plugin, occurrences, native || []);
    this.renderMentions(body, file, mentions);
  }
}
