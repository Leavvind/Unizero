import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type UnizeroPlugin from "./main";
import type { LinkOccurrence } from "./linkIndex";
import { occurrenceSnippet } from "./documentLinks";
import { openLinkOccurrence } from "./linkOpening";
import { describeTarget, serializeLinkTarget } from "./linkTarget";

export const BACKLINKS_VIEW_TYPE = "unizero-backlinks";
export function renderCoverage(container: HTMLElement, plugin: UnizeroPlugin): void {
  const index = plugin.vaultIndex.links, c = index.coverage;
  if (!plugin.settings.indexZoteroSources) {
    const notice = container.createDiv({ cls: "unizero-links__notice", text: "Links written in Zotero documents are not listed: Zotero documents are not indexed." });
    notice.createEl("button", { text: "Index Zotero documents" }).onclick = () => {
      plugin.settings.indexZoteroSources = true;
      void plugin.saveSettings("none").then(() => plugin.configureExternalIndex()).catch((error) => plugin.reportError(error));
    };
  }
  const status = container.createDiv({ cls: "unizero-links__coverage" });
  const scanned = c.lastSuccess ? new Date(c.lastSuccess) : undefined;
  status.createSpan({ text: [`Vault ${index.vaultState}`, `Zotero ${c.state}`, c.unavailable ? `${c.unavailable} unavailable` : "",
    scanned ? `scanned ${scanned.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""].filter(Boolean).join(" · ") });
  status.title = [c.scope, scanned ? `Last successful Zotero scan: ${scanned.toLocaleString()}` : ""].filter(Boolean).join("\n");
  const refresh = status.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Refresh links" } });
  setIcon(refresh, "refresh-cw");
  refresh.onclick = () => { void plugin.refreshLinks(); };
  if (c.error) { container.createDiv({ cls: "unizero-links__notice", text: c.error }); }
}
export function renderOccurrences(container: HTMLElement, plugin: UnizeroPlugin, occurrences: LinkOccurrence[]): void {
  if (!occurrences.length) { container.createEl("p", { text: "No incoming links in the sources scanned so far." }); return; }
  for (const kind of ["zotero", "vault"] as const) {
    const links = occurrences.filter((o) => o.source.kind === kind);
    if (!links.length) { continue; }
    container.createDiv({ cls: "unizero-links__section", text: `${kind === "zotero" ? "Zotero" : "Vault"} (${links.length})` });
    const groups = new Map<string, LinkOccurrence[]>();
    for (const occurrence of links) {
      const source = occurrence.source;
      const key = source.kind === "zotero" ? `${source.libraryID}/${source.itemKey}/${source.attachmentKey}` : source.path;
      const group = groups.get(key) || []; group.push(occurrence); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const source = group[0].source, box = container.createDiv({ cls: "unizero-links__group" });
      const header = box.createDiv({ cls: "unizero-links__source" });
      header.title = `${source.kind === "zotero" ? source.purpose + " · " : ""}${source.path || "File unavailable"}`;
      if (source.kind === "zotero") {
        header.createEl("a", { cls: "unizero-links__name", text: source.itemTitle }).onclick = () => { void plugin.showInDetailView(source); };
        header.createSpan({ cls: "unizero-links__file", text: source.title });
      } else {
        header.createSpan({ cls: "unizero-links__name", text: source.title });
      }
      if (group.length > 1) { header.createSpan({ cls: "unizero-links__count", text: String(group.length) }); }
      for (const occurrence of group) {
        const row = box.createDiv({ cls: "unizero-link-occurrence", attr: { role: "button", tabindex: "0" } });
        row.title = serializeLinkTarget(occurrence.target);
        row.createSpan({ cls: "unizero-link-occurrence__line", text: `${occurrence.stale ? "stale " : ""}${occurrence.nodeId ? `Card ${occurrence.nodeId} ` : ""}L${occurrence.line + 1}` });
        row.createSpan({ cls: "unizero-link-occurrence__text", text: occurrenceSnippet(occurrence.lineText, occurrence.ch) });
        const target = describeTarget(occurrence.target);
        if (target) { row.createSpan({ cls: "unizero-link-occurrence__target", text: target }); }
        const open = () => { void openLinkOccurrence(plugin, occurrence).catch((error) => plugin.reportError(error)); };
        row.onclick = open;
        row.onkeydown = (event) => { if (event.key === "Enter") { open(); } };
      }
    }
  }
}
export class BacklinksView extends ItemView {
  private unsubscribe?: () => void;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnizeroPlugin) { super(leaf); }
  getViewType(): string { return BACKLINKS_VIEW_TYPE; }
  getDisplayText(): string { return "UniZero Backlinks"; }
  getIcon(): string { return "links-coming-in"; }
  async onOpen(): Promise<void> { this.unsubscribe = this.plugin.vaultIndex.links.subscribe(() => this.render()); this.render(); }
  async onClose(): Promise<void> { this.unsubscribe?.(); }
  private render(): void {
    const body = this.contentEl; body.empty();
    renderCoverage(body, this.plugin);
    const external = this.plugin.currentExternal || (this.plugin.externalDocumentPath ? this.plugin.externalIndex?.findPath(this.plugin.externalDocumentPath) : undefined);
    if (external?.kind === "zotero") {
      body.createEl("p", { text: `This is a Zotero attachment: ${external.title}` });
      body.createEl("button", { text: "Open its Item pane" }).onclick = () => { void this.plugin.showInDetailView(external); };
      return;
    }
    if (this.plugin.externalDocumentPath) { body.createEl("p", { text: "This external document is not in the scanned Zotero source directory. Enable or refresh Zotero sources to identify its Item." }); return; }
    const file = this.plugin.currentDocument;
    if (!file) { body.createEl("p", { text: "Open a Vault Markdown document." }); return; }
    body.createDiv({ cls: "unizero-links__section", text: file.basename });
    const note = this.plugin.identity.get(file.path);
    if (!note?.uid) {
      body.createEl("p", { text: note?.error || "This document has no stable identity." });
      body.createEl("button", { text: "Set document UID…" }).onclick = () => { void this.plugin.assignDocumentUID(); };
      return;
    }
    const resolution = this.plugin.identity.resolve(this.plugin.settings.vaultID, note.uid);
    if (resolution.status === "conflict") { body.createEl("p", { text: `UID conflict: ${resolution.notes.map((n) => n.path).join(", ")}` }); return; }
    renderOccurrences(body, this.plugin, this.plugin.vaultIndex.links.query({ kind: "note", vaultID: this.plugin.settings.vaultID, uid: note.uid }));
  }
}
