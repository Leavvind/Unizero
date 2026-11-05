import { Modal, Setting, SuggestModal, Notice, type App } from "obsidian";
import { readFile } from "fs/promises";
import type UnizeroPlugin from "./main";
import type { LinkTarget, TextLocation } from "./linkTarget";
import { textAnchors } from "./documentLinks";

export function pick<T>(app: App, title: string, items: { label: string; value: T }[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    class Picker extends SuggestModal<{ label: string; value: T }> {
      chosen = false;
      getSuggestions(query: string) { return items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())); }
      renderSuggestion(item: { label: string; value: T }, el: HTMLElement) { el.setText(item.label); }
      onChooseSuggestion(item: { label: string; value: T }) { this.chosen = true; resolve(item.value); }
      onClose() { window.setTimeout(() => { if (!this.chosen) { resolve(undefined); } }, 0); }
    }
    const modal = new Picker(app); modal.setPlaceholder(title); modal.open();
  });
}
export function inputText(app: App, title: string, initial = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    class Input extends Modal {
      value = initial; done = false;
      onOpen() {
        this.titleEl.setText(title);
        new Setting(this.contentEl).addText((text) => text.setValue(initial).onChange((v) => { this.value = v; }));
        new Setting(this.contentEl).addButton((button) => button.setButtonText("Use").setCta().onClick(() => {
          this.done = true; resolve(this.value); this.close();
        }));
      }
      onClose() { if (!this.done) { resolve(undefined); } }
    }
    new Input(app).open();
  });
}

/** Explicit second-stage chooser shared by insertion and relocation. */
export async function chooseLinkLocation(plugin: UnizeroPlugin, target: LinkTarget): Promise<LinkTarget | undefined> {
  let text: string | undefined;
  let base: LinkTarget = { ...target, location: undefined };
  if (target.kind === "paper") {
    const action = await pick(plugin.app, "Choose target", [
      { label: "Item pane", value: "detail" }, { label: "PDF / physical page", value: "pdf" }, { label: "Raw / heading / block", value: "markdown" },
    ]);
    if (!action) { return; }
    if (action === "detail") { return { kind: "paper", libraryID: target.libraryID, itemKey: target.itemKey, action }; }
    const files = await plugin.bridge.artifacts(target);
    const choices = action === "pdf" ? files.pdfs.map((f) => ({ label: f.title + (f.main ? " (default)" : ""), value: f.key }))
      : files.artifacts.filter((f) => f.kind === "raw").map((f) => ({ label: f.title, value: f.key }));
    const attachmentKey = await pick(plugin.app, "Choose attachment (required)", choices);
    if (!attachmentKey) { return; }
    base = { kind: "paper", libraryID: target.libraryID, itemKey: target.itemKey, action: action as "pdf" | "markdown", attachmentKey };
    if (action === "pdf") {
      const page = await inputText(plugin.app, "Physical PDF page (leave empty for file)", target.page?.toString() || "");
      if (page === undefined) { return; }
      if (page && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) { new Notice("Enter a positive physical page number."); return; }
      return { ...base, ...(page ? { page: Number(page) } : {}) };
    }
    const resolved = await plugin.bridge.linkTarget(target, "markdown", attachmentKey);
    if (!resolved.source?.path) { new Notice("This Raw is not available locally. No conversion or download was started."); return; }
    text = await readFile(resolved.source.path, "utf8");
  } else {
    const resolved = plugin.identity.resolve(target.vaultID, target.uid);
    if (resolved.status !== "found") { new Notice(`UniZero: document identity is ${resolved.status}.`); return; }
    text = await plugin.app.vault.adapter.read(resolved.notes[0].path);
  }
  const location = await pick<TextLocation | null>(plugin.app, "Choose file, #heading or ^block", [
    { label: "Open file", value: null }, ...textAnchors(text).map((a) => ({
      label: `${a.level ? `H${a.level} ` : "^"}${a.location.value} (line ${a.line + 1})`, value: a.location,
    })),
  ]);
  return location === undefined ? undefined : { ...base, ...(location ? { location } : {}) };
}
