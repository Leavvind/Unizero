import { Modal, Notice, Setting, MarkdownView, TFile } from "obsidian";
import { readFile } from "fs/promises";
import { replaceLocalDocument } from "./localDocuments";
import { contentHash, normalizeLocalPath } from "./externalIndex";
import type UnizeroPlugin from "./main";
import { pick } from "./linkPicker";

import { planTransition, type TransitionEdit, type TransitionPlan } from "./transitionPlan";

export interface TransitionFile { id: string; format: "md" | "canvas"; read(): Promise<string>; write(expected: string, content: string, edits?: TransitionEdit[]): Promise<void> }
interface Journal { schema: 1; created: number; entries: { id: string; format: "md" | "canvas"; before: string; after: string; status: "pending" | "applied" | "skipped" | "restored"; error?: string }[] }

export function transitionFile(plugin: UnizeroPlugin, id: string, format: "md" | "canvas"): TransitionFile {
  const external = id.startsWith("zotero:");
  function sourcePath(): string {
    const source = plugin.vaultIndex.links.records.get(id)?.source;
    if (external && (source?.kind !== "zotero" || !source.path)) { throw new Error("Attachment is not in the declared source directory."); }
    return external ? source!.path! : id.replace(/^vault:/, "");
  }
  return { id, format,
    read: async () => external ? readFile(sourcePath(), "utf8") : plugin.app.vault.adapter.read(sourcePath()),
    write: async (expected, content, edits) => {
      const path = sourcePath();
      for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as MarkdownView;
        if (view.getMode() === "source" && view.file && normalizeLocalPath(view.file.path) === normalizeLocalPath(path)) {
          const current = view.editor.getValue();
          if (contentHash(current) !== contentHash(expected)) { throw new Error("Editor changed since preview; generate a new plan."); }
          const disk = external ? await readFile(path, "utf8") : await plugin.app.vault.adapter.read(path);
          if (contentHash(disk) !== contentHash(expected)) { throw new Error("File changed since preview; generate a new plan."); }
          const changes = (edits || [{ from: 0, to: current.length, text: content }]).map((e) => ({
            from: view.editor.offsetToPos(e.from), to: view.editor.offsetToPos(e.to), text: e.text,
          }));
          view.editor.transaction({ changes });
          await view.save();
          return;
        }
      }
      if (!external) {
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) { throw new Error("Document is missing."); }
        await plugin.app.vault.process(file, (current) => {
          if (contentHash(current) !== contentHash(expected)) { throw new Error("File changed since preview; generate a new plan."); }
          return content;
        });
      } else {
        // Existing file only; journal is persisted before any attachment edit.
        await replaceLocalDocument(path, expected, content);
      }
    },
  };
}

export async function startTransition(plugin: UnizeroPlugin): Promise<void> {
  const scope = await pick(plugin.app, "Transition scope", [
    { label: "Current Vault document", value: "current" }, { label: "Vault Markdown and Canvas", value: "vault" },
    { label: "Explicitly selected Zotero documents", value: "zotero" },
  ]);
  if (!scope) { return; }
  const records = [...plugin.vaultIndex.links.records.entries()].filter(([, record]) => scope === "zotero"
    ? record.source.kind === "zotero" : record.source.kind === "vault" && (scope !== "current" || record.source.path === plugin.currentDocument?.path));
  const selected = new Set<string>();
  if (scope !== "zotero") { records.forEach(([id]) => selected.add(id)); }
  else {
    await new Promise<void>((resolve) => {
      class Selection extends Modal {
        onOpen() {
          this.titleEl.setText("Select Zotero documents to preview");
          for (const [id, record] of records) { new Setting(this.contentEl).setName(record.source.title).setDesc(record.source.path || "Unavailable")
            .addToggle((toggle) => toggle.setValue(false).onChange((value) => { if (value) { selected.add(id); } else { selected.delete(id); } })); }
          new Setting(this.contentEl).addButton((button) => button.setButtonText("Preview selected").onClick(() => this.close()));
        }
        onClose() { resolve(); }
      }
      new Selection(plugin.app).open();
    });
  }
  const plans: TransitionPlan[] = [];
  for (const [id, record] of records.filter(([id]) => selected.has(id))) {
    try {
      const file = transitionFile(plugin, id, record.source.format);
      plans.push(await planTransition(id, file.format, await file.read(), async (ref) => {
        const state = await plugin.store.load(ref); return state.status === "ready" ? state.paper : undefined;
      }));
    } catch (error) { plans.push({ id, format: record.source.format, before: "", after: "", hash: "", edits: [], count: 0, examples: [], skipped: [(error as Error).message] }); }
  }
  new TransitionPreview(plugin, plans).open();
}

class TransitionPreview extends Modal {
  constructor(private readonly plugin: UnizeroPlugin, private readonly plans: TransitionPlan[]) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText("Transition preview");
    this.contentEl.createEl("p", { text: `${this.plans.length} files; ${this.plans.reduce((sum, p) => sum + p.count, 0)} citations. Originals and an operation journal are saved before applying.` });
    const selected = new Set(this.plans.filter((p) => p.count).map((p) => p.id));
    for (const plan of this.plans) {
      new Setting(this.contentEl).setName(plan.id).setDesc(`${plan.count} citations; ${plan.skipped.length} skipped`)
        .addToggle((toggle) => toggle.setValue(selected.has(plan.id)).onChange((value) => { if (value) { selected.add(plan.id); } else { selected.delete(plan.id); } }));
      for (const text of [...plan.examples, ...plan.skipped]) { this.contentEl.createEl("p", { text }); }
    }
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Apply selected").setCta().onClick(() => {
      button.setDisabled(true);
      void applyPlans(this.plugin, this.plans.filter((p) => selected.has(p.id) && p.count)).then(() => this.close())
        .catch((error) => { new Notice(`UniZero: ${(error as Error).message}`); button.setDisabled(false); });
    }));
  }
}
async function journalFolder(plugin: UnizeroPlugin): Promise<string> {
  const path = `${plugin.manifest.dir}/transitions`;
  if (!(await plugin.app.vault.adapter.exists(path))) { await plugin.app.vault.adapter.mkdir(path); }
  return path;
}
async function applyPlans(plugin: UnizeroPlugin, plans: TransitionPlan[]): Promise<void> {
  if (!plans.length) { return; }
  const journal: Journal = { schema: 1, created: Date.now(), entries: plans.map((p) => ({ id: p.id, format: p.format, before: p.before, after: p.after, status: "pending" })) };
  const path = `${await journalFolder(plugin)}/${journal.created}.json`;
  const persist = () => plugin.app.vault.adapter.write(path, JSON.stringify(journal));
  await persist();
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i], entry = journal.entries[i];
    try { await transitionFile(plugin, plan.id, plan.format).write(plan.before, plan.after, plan.edits); entry.status = "applied"; }
    catch (error) { entry.status = "skipped"; entry.error = (error as Error).message; }
    await persist();
  }
  new Notice(`UniZero: ${journal.entries.filter((e) => e.status === "applied").length} files migrated; ${journal.entries.filter((e) => e.status === "skipped").length} skipped. Recovery journal saved.`);
  await plugin.refreshLinks();
}
export async function restoreTransition(plugin: UnizeroPlugin): Promise<void> {
  const files = (await plugin.app.vault.adapter.list(await journalFolder(plugin))).files.filter((f) => f.endsWith(".json"));
  const path = await pick(plugin.app, "Choose a Transition to restore", files.map((f) => ({ label: f.split("/").pop()!, value: f })));
  if (!path) { return; }
  const journal: Journal = JSON.parse(await plugin.app.vault.adapter.read(path));
  if (journal.schema !== 1) { throw new Error("Unsupported recovery journal"); }
  const choice = await pick(plugin.app, "Restore originals only where the current content still matches the migration", [{ label: "Restore matching files", value: true }]);
  if (!choice) { return; }
  let restored = 0;
  for (const entry of journal.entries) {
    if (entry.status === "restored" || entry.status === "skipped") { continue; }
    try {
      await transitionFile(plugin, entry.id, entry.format).write(entry.after, entry.before);
      entry.status = "restored"; restored += 1;
      await plugin.app.vault.adapter.write(path, JSON.stringify(journal));
    } catch (error) { new Notice(`UniZero: ${entry.id}: ${(error as Error).message}`); }
  }
  new Notice(`UniZero: restored ${restored} files.`); await plugin.refreshLinks();
}
