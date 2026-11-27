import { debounce, ItemView, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type UnizeroPlugin from "./main";
import { sourceIdentity, type LinkOccurrence } from "./linkIndex";
import { occurrenceSnippet } from "./documentLinks";
import { openLinkOccurrence, openNativeBacklink } from "./linkOpening";
import { nativeOutgoing, type NativeLinkForm, type NativeOutgoingLink } from "./nativeLinks";
import { describeTarget, markdownLink, paperLabel, serializeLinkTarget } from "./linkTarget";
import { findMentions, mentionSnippet, type Mention } from "./unlinkedMentions";
import { groupOutgoingMentions, mentionTargets, outgoingGroups, presentTerms, type OutgoingGroup, type OutgoingRow, type OutgoingSection } from "./outgoingLinks";

export const OUTGOING_LINKS_VIEW_TYPE = "unizero-outgoing-links";
const FORM_LABEL: Record<NativeLinkForm, string> = { wikilink: "wikilink", embed: "embed", markdown: "Markdown", property: "property", file: "linked" };
const SECTION_LABEL: Record<OutgoingSection, string> = { paper: "Papers", note: "Notes", unresolved: "Unresolved" };
const basename = (path: string) => path.split("/").pop()!.replace(/\.(md|canvas)$/, "");

/**
 * What the followed document links to: papers, Vault notes and files, and links that
 * do not resolve, each group headed by its destination. The header follows the link;
 * a row shows where the link is written. Like Backlinks, it follows the last active
 * document and only reads: nothing is written except through an explicit `Link`.
 */
export class OutgoingLinksView extends ItemView {
  private unsubscribe?: () => void;
  private generation = 0;
  /** Unlinked mentions match every Vault title against the note, so only while the section is open. */
  private mentionsOpen = false;
  private readonly expandedMentions = new Set<string>();
  /** The note the mentions section belongs to; another note starts collapsed. */
  private mentionTarget?: string;
  private stale = false;
  private readonly indexedAhead = new Set<string>();
  private readonly scheduleRender = debounce(() => {
    if (!this.contentEl.isShown()) { this.stale = true; return; }
    void this.render();
  }, 300, true);
  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnizeroPlugin) { super(leaf); }
  getViewType(): string { return OUTGOING_LINKS_VIEW_TYPE; }
  getDisplayText(): string { return "UniZero Outgoing links"; }
  getIcon(): string { return "links-going-out"; }
  async onOpen(): Promise<void> {
    // The followed note's own record, and every UID it names, reach the pane through the link index.
    this.unsubscribe = this.plugin.vaultIndex.links.subscribe(() => this.scheduleRender());
    // Native links resolve when the note changes or a file they name appears or moves.
    this.registerEvent(this.app.metadataCache.on("resolve", (file) => { if (file.path === this.plugin.currentDocument?.path) { this.scheduleRender(); } }));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.showIfStale()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.showIfStale()));
    await this.render();
  }
  onResize(): void { this.showIfStale(); }
  async onClose(): Promise<void> { this.unsubscribe?.(); this.scheduleRender.cancel(); this.generation++; }
  private showIfStale(): void {
    if (this.stale && this.contentEl.isShown()) { this.stale = false; void this.render(); }
  }
  private indexAhead(file: TFile): void {
    if (this.indexedAhead.has(file.path)) { return; }
    this.indexedAhead.add(file.path);
    void this.plugin.vaultIndex.indexFile(file).then(() => this.scheduleRender(), (error) => this.plugin.reportError(error));
  }
  private run(action: () => Promise<void> | void): void {
    void Promise.resolve().then(action).catch((error) => this.plugin.reportError(error));
  }
  private clickable(el: HTMLElement, action: () => Promise<void> | void): void {
    el.setAttr("role", "button"); el.setAttr("tabindex", "0");
    el.onclick = (event) => { event.stopPropagation(); this.run(action); };
    el.onkeydown = (event) => { if (event.key === "Enter" && event.target === el) { event.stopPropagation(); this.run(action); } };
  }
  /** Follows a native link the way Obsidian does, which may create an unresolved note. */
  private openNative(link: NativeOutgoingLink, sourcePath: string): Promise<void> {
    return this.app.workspace.openLinkText(link.subpath ? `${link.linkpath}#${link.subpath}` : link.linkpath, sourcePath, false);
  }
  private renderHeader(box: HTMLElement, group: OutgoingGroup, sourcePath: string | undefined): void {
    const header = box.createDiv({ cls: "unizero-links__source" });
    const first = group.rows[0];
    if (group.paper) {
      const paper = group.paper, state = this.plugin.store.peek(paper);
      // Titles come from Zotero once per paper; a failure is not retried on every render.
      if (!state) { void this.plugin.store.load(paper).then(() => this.scheduleRender()); }
      const name = header.createEl("a", { cls: "unizero-links__name", text: state?.status === "ready" ? paperLabel(state.paper) : group.label });
      this.clickable(name, () => this.plugin.showInDetailView(paper));
      if (state?.status === "ready" && state.paper.title) { header.createSpan({ cls: "unizero-links__file", text: state.paper.title }); }
      if (state?.status === "missing") { header.createSpan({ cls: "unizero-links__file", text: "Not in Zotero" }); }
      header.title = state?.status === "error" ? state.message : `${paper.libraryID}/${paper.itemKey}`;
    } else if (group.path) {
      const path = group.path;
      header.title = path;
      const name = header.createEl("a", { cls: "unizero-links__name", text: group.label });
      this.clickable(name, async () => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) { throw new Error("The document is missing."); }
        await this.app.workspace.getLeaf(false).openFile(file);
      });
    } else {
      header.title = group.problem || "";
      const name = header.createEl("a", { cls: "unizero-links__name is-unresolved", text: group.label });
      // An unresolved native link opens as Obsidian would; a UniZero one reports why it cannot.
      this.clickable(name, () => first.kind === "native" && sourcePath ? this.openNative(first.link, sourcePath) : this.plugin.openLink((first as Extract<OutgoingRow, { kind: "unizero" }>).occurrence.target));
      if (group.problem) { header.createSpan({ cls: "unizero-links__file", text: group.problem }); }
    }
    if (group.rows.length > 1) { header.createSpan({ cls: "unizero-links__count", text: String(group.rows.length) }); }
  }
  private renderRow(box: HTMLElement, row: OutgoingRow, sourcePath: string | undefined, showForm: boolean): void {
    const el = box.createDiv({ cls: "unizero-link-occurrence" });
    const meta = el.createSpan({ cls: "unizero-link-occurrence__line" });
    if (row.kind === "unizero") {
      const occurrence = row.occurrence;
      el.title = serializeLinkTarget(occurrence.target);
      if (showForm) { meta.createSpan({ cls: "unizero-link-occurrence__form is-unizero", text: "UniZero" }); }
      meta.appendText(`${occurrence.stale ? "stale " : ""}${occurrence.nodeId ? `Card ${occurrence.nodeId} ` : ""}L${occurrence.line + 1}`);
      el.createSpan({ cls: "unizero-link-occurrence__text", text: occurrenceSnippet(occurrence.lineText, occurrence.ch) });
      const target = describeTarget(occurrence.target);
      if (target) { this.clickable(el.createEl("a", { cls: "unizero-link-occurrence__target", text: target }), () => this.plugin.openLink(occurrence.target)); }
      this.clickable(el, () => openLinkOccurrence(this.plugin, occurrence));
      el.oncontextmenu = (event) => { event.preventDefault(); this.plugin.linkMenu(event, occurrence.target); };
      return;
    }
    const link = row.link;
    el.title = link.raw;
    meta.createSpan({ cls: "unizero-link-occurrence__form", text: FORM_LABEL[link.form] });
    if (link.line !== undefined) { meta.appendText(`L${link.line + 1}`); }
    el.createSpan({ cls: "unizero-link-occurrence__text", text: link.form === "property" ? `${link.key?.replace(/\.\d+$/, "")}: ${link.raw}`
      : link.lineText !== undefined ? occurrenceSnippet(link.lineText, link.ch!) : link.raw });
    if (link.subpath && sourcePath) { this.clickable(el.createEl("a", { cls: "unizero-link-occurrence__target", text: `#${link.subpath}` }), () => this.openNative(link, sourcePath)); }
    if (sourcePath) { this.clickable(el, () => openNativeBacklink(this.plugin, { sourcePath, line: link.line })); }
  }
  private renderGroups(body: HTMLElement, groups: OutgoingGroup[], sourcePath: string | undefined, showForm: boolean): void {
    for (const section of ["paper", "note", "unresolved"] as const) {
      const list = groups.filter((group) => group.section === section);
      if (!list.length) { continue; }
      body.createDiv({ cls: "unizero-links__section", text: `${SECTION_LABEL[section]} (${list.length})` });
      for (const group of list) {
        const box = body.createDiv({ cls: "unizero-links__group" });
        this.renderHeader(box, group, sourcePath);
        for (const row of group.rows) { this.renderRow(box, row, sourcePath, showForm); }
      }
    }
  }
  /** Unlinked mentions of other notes' titles and aliases in `file`, by the note they may name. */
  private async unlinkedMentions(file: TFile, linked: Set<string>): Promise<Array<{ path: string; mentions: Mention[] }>> {
    const { metadataCache, vault } = this.app;
    const candidates = vault.getMarkdownFiles().map((note) => {
      const aliases: unknown = metadataCache.getFileCache(note)?.frontmatter?.aliases;
      const list: unknown[] = Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [];
      return { path: note.path, basename: note.basename, aliases: list.filter((alias): alias is string => typeof alias === "string") };
    });
    const targets = mentionTargets(candidates, file.path, linked);
    const text = await vault.cachedRead(file);
    const terms = presentTerms(text, targets);
    return terms.length ? groupOutgoingMentions(findMentions(text, terms), targets) : [];
  }
  /** Turns one mention in `file` into a UniZero link to `targetPath`, giving the target a UID first if it has none. */
  private async linkMention(file: TFile, targetPath: string, mention: Mention): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(target instanceof TFile)) { throw new Error("The linked note is missing."); }
    const uid = await this.plugin.setDocumentUID(target);
    if (!uid) { return; }
    const link = markdownLink(mention.text, { kind: "note", vaultID: this.plugin.settings.vaultID, uid });
    let changed = false;
    await this.app.vault.process(file, (text) => {
      if (text.slice(mention.from, mention.to) !== mention.text) { changed = true; return text; }
      return text.slice(0, mention.from) + link + text.slice(mention.to);
    });
    if (changed) { new Notice("The note changed since the mentions were listed; try again."); }
    this.scheduleRender();
  }
  private renderMentions(body: HTMLElement, file: TFile, found: Array<{ path: string; mentions: Mention[] }> | undefined): void {
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
  private renderMention(box: HTMLElement, file: TFile, targetPath: string, mention: Mention): void {
    const el = box.createDiv({ cls: "unizero-link-occurrence unizero-mention", attr: { role: "button", tabindex: "0" } });
    el.createSpan({ cls: "unizero-link-occurrence__line", text: `L${mention.line + 1}` });
    const snippet = mentionSnippet(mention.lineText, mention.ch, mention.text.length);
    const text = el.createSpan({ cls: "unizero-link-occurrence__text" });
    text.appendText(snippet.before);
    text.createEl("mark", { cls: "unizero-mention__match", text: snippet.match });
    text.appendText(snippet.after);
    const link = el.createEl("button", { cls: "unizero-mention__link", text: "Link" });
    link.title = `Replace "${mention.text}" with a UniZero link to ${basename(targetPath)}`;
    link.onclick = (event) => { event.stopPropagation(); this.run(() => this.linkMention(file, targetPath, mention)); };
    const open = () => this.run(() => openNativeBacklink(this.plugin, { sourcePath: file.path, line: mention.line }));
    el.onclick = open;
    el.onkeydown = (event) => { if (event.key === "Enter" && event.target === el) { open(); } };
  }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    this.plugin.syncActiveDocument();
    const index = this.plugin.vaultIndex.links;
    const external = this.plugin.currentExternal || (this.plugin.externalDocumentPath ? this.plugin.externalIndex?.findPath(this.plugin.externalDocumentPath) : undefined);
    const resolveNote = (vaultID: string, uid: string) => this.plugin.identity.resolve(vaultID, uid);
    const file = this.plugin.currentDocument;
    if (this.mentionTarget !== file?.path) { this.mentionTarget = file?.path; this.expandedMentions.clear(); this.mentionsOpen = false; }
    if (external?.kind === "zotero") {
      // A Zotero attachment such as Raw: its UniZero links, from the scanned Zotero sources.
      const body = this.contentEl; body.empty();
      const header = body.createDiv({ cls: "unizero-links__paper" });
      header.createSpan({ text: external.title });
      header.createEl("button", { text: "Item pane" }).onclick = () => { void this.plugin.showInDetailView(external); };
      const record = index.records.get(sourceIdentity(external));
      if (record?.error) { body.createDiv({ cls: "unizero-links__notice", text: record.error }); }
      const groups = outgoingGroups(record?.links || [], [], resolveNote);
      if (!groups.length) { body.createDiv({ cls: "unizero-links__notice", text: "No UniZero links in this document." }); }
      this.renderGroups(body, groups, undefined, false);
      return;
    }
    if (this.plugin.externalDocumentPath) {
      const body = this.contentEl; body.empty();
      body.createDiv({ cls: "unizero-links__notice", text: this.plugin.settings.indexZoteroSources
        ? "This document is not in the scanned Zotero sources yet."
        : "Turn on Index Zotero documents in Settings to list links for this document." });
      return;
    }
    if (!file) { const body = this.contentEl; body.empty(); body.createEl("p", { text: "Open a Vault Markdown document." }); return; }
    // The note's own record holds its UniZero links; it needs no UID of its own.
    const record = index.records.get(`vault:${file.path}`);
    let occurrences: LinkOccurrence[] = record?.links || [];
    const reading = !record && index.vaultState !== "complete";
    if (reading) { this.indexAhead(file); occurrences = []; }
    const { metadataCache, vault } = this.app;
    let native: NativeOutgoingLink[] | undefined;
    try {
      native = nativeOutgoing({
        fileCache: (path) => metadataCache.getCache(path),
        resolve: (linkpath, sourcePath) => metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path,
      }, file.path, await vault.cachedRead(file));
    } catch (error) { console.error("UniZero native outgoing links", error); }
    if (generation !== this.generation) { return; }
    const groups = outgoingGroups(occurrences, native || [], resolveNote);
    const linked = new Set(groups.flatMap((group) => group.path ? [group.path] : []));
    const mentions = this.mentionsOpen ? await this.unlinkedMentions(file, linked).catch((error) => {
      console.error("UniZero unlinked mentions", error); return undefined;
    }) : undefined;
    // A newer render started while this one read the note.
    if (generation !== this.generation) { return; }
    const body = this.contentEl; body.empty();
    if (reading) { body.createDiv({ cls: "unizero-links__notice", text: "Reading this document's UniZero links…" }); }
    if (!native) { body.createDiv({ cls: "unizero-links__notice", text: "Obsidian links could not be read; see the developer console." }); }
    this.renderGroups(body, groups, file.path, true);
    this.renderMentions(body, file, mentions);
  }
}
