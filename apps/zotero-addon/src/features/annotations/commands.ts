/**
 * Annotation injection command: inject Zotero highlights and underlines into the
 * generated Markdown.
 *
 * Ported from the annotation half of ZoMiner's `modules/commands.js`, with
 * identical behaviour.
 *
 * Injection is idempotent: the runtime marks each annotation by key, so running it
 * again only adds the new ones.
 */

import { runtimeClient } from "../../runtime-client/client";
import { ensure } from "../../runtime-client/process";
import { annotationPayload, regularParents } from "../../zotero/annotationAdapter";
import { showError, startBatch } from "../../ui/progress";
import { reportServiceFailure } from "../../ui/notices";

/** Put the runtime's injection counts into plain words. */
function describeResult(result: {
  injected: number;
  total: number;
  already?: number;
  skipped?: unknown[];
}): string {
  let message = `Injected ${result.injected}/${result.total}`;
  if (result.already) { message += ` (${result.already} already present)`; }
  if (result.skipped?.length) { message += `, ${result.skipped.length} unmatched`; }
  return message;
}

export async function annotateSelected(mainWindow: Window): Promise<void> {
  const items = (mainWindow as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  if (!items.length) { return; }

  const parents = regularParents(items);
  if (!parents.length) {
    showError("Select one or more bibliographic items");
    return;
  }

  if (!(await ensure({ reportError: reportServiceFailure }))) { return; }

  const batch = startBatch("UniZero — Annotation injection");
  for (const parent of parents) {
    const title = parent.getField("title");
    const line = batch.addLine(title);
    line.setProgress(30);
    try {
      const payload = annotationPayload(parent);
      // Having nothing to inject is not an error: the user may simply not have
      // read this paper yet.
      if (!payload.annotations.length) {
        line.setProgress(100);
        line.setText(`No injectable annotations (highlights/underlines only): ${title}`);
        continue;
      }
      const result = await runtimeClient.annotate(payload);
      line.setProgress(100);
      line.setText(`${describeResult(result)}: ${title}`);
    } catch (error) {
      line.setError();
      line.setText(`Failed: ${error}`);
      ztoolkit.log(`annotate error: ${error}`);
    }
  }
  batch.finish();
}
