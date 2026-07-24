/**
 * Conversion commands: send the selected Zotero items through the paper runtime,
 * then register the resulting artifacts back onto Zotero.
 *
 * Ported from the conversion half of ZoMiner's `modules/commands.js`.
 *
 * Nothing here draws progress. Once the runtime accepts a job it owns it, and the
 * panel already lists every job the runtime holds — status, log tail, and output path
 * included. A progress window would only mirror that list into the corner of the
 * screen, for the several minutes a conversion takes, over whatever the user moved on
 * to. So the panel is opened instead, and this module reports only what the runtime's
 * job list cannot: requests it never accepted, and the Zotero-side registration that
 * happens after a job is already done.
 */

import { runtimeClient } from "../../runtime-client/client";
import { ensure } from "../../runtime-client/process";
import type { JobState } from "../../runtime-client/contracts";
import {
  conversionPayload,
  conversionTargets,
  markConverted,
} from "../../zotero/conversionAdapter";
import { noteConversionFailure, noteServiceFailure } from "../../ui/notices";
import { openPanel } from "../../ui/panel";
import { getConversionPref } from "./settings";

/**
 * Job polling interval.
 *
 * The runtime is a single-worker queue and conversions take minutes; polling
 * harder makes nothing faster and only floods the log. The panel refreshes on its
 * own clock — this poll exists solely to learn when the Zotero-side follow-up can run.
 */
const POLL_MS = 3000;

/**
 * Poll until the job reaches a terminal state.
 *
 * No log tail is requested: the panel already shows the running commentary, and this
 * loop only needs to know when the job is over.
 */
async function pollJob(jobId: string): Promise<JobState> {
  for (;;) {
    await Zotero.Promise.delay(POLL_MS);
    const status = await runtimeClient.job(jobId, 0);
    if (status.status === "done" || status.status === "failed") { return status; }
  }
}

function targetTitle(target: {
  parent: Zotero.Item | null;
  attachment: Zotero.Item;
  isSupplement: boolean;
}): string {
  let title = target.parent
    ? target.parent.getField("title")
    : target.attachment.getField("title") || target.attachment.key;
  if (target.isSupplement) {
    title += ` — ${target.attachment.getField("title") || target.attachment.key}`;
  }
  return title;
}

/**
 * Convert an explicit set of items.
 *
 * Processed one at a time rather than concurrently: the runtime is a single
 * worker anyway, so concurrent submissions only queue up. One failure does not stop
 * the batch. Taking explicit items lets adapters such as Literature Explorer reuse
 * the command without changing Zotero's current selection as an implementation
 * detail.
 */
export async function convertItems(
  mainWindow: Window,
  items: Zotero.Item[],
  templateId: string,
  templateName?: string,
): Promise<void> {
  if (!items.length) { return; }

  // Opened before anything can go wrong, because the panel is now the only place
  // this command reports to — including the refusals below, which happen at once.
  openPanel(mainWindow);

  const targets = await conversionTargets(items);
  if (!targets.length) {
    noteConversionFailure("The selected items have no usable PDF attachment");
    return;
  }

  if (!(await ensure({ reportError: noteServiceFailure }))) { return; }

  for (const target of targets) {
    const title = targetTitle(target);
    try {
      const accepted = await runtimeClient.convert(
        conversionPayload(target, templateId),
      );
      ztoolkit.log(`job ${accepted.job_id} (${templateName || templateId}) for ${title}`);

      const final = await pollJob(accepted.job_id);
      // A failed job is already a failed row in the panel carrying the runtime's own
      // error; repeating it as a notice would put the same failure on screen twice.
      if (final.status !== "done") { continue; }

      await markConverted(target, final.result || {}, {
        mdSnapshot: getConversionPref("mdSnapshot"),
      });
    } catch (error) {
      // Either the runtime never accepted the request — so there is no job row to
      // carry the reason — or the Zotero-side registration after it failed, which the
      // runtime knows nothing about.
      noteConversionFailure(String(error), title);
    }
  }
}

/** Convert the items selected in Zotero's main item tree. */
export async function convertSelected(
  mainWindow: Window,
  templateId: string,
  templateName?: string,
): Promise<void> {
  const items = (mainWindow as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  await convertItems(mainWindow, items, templateId, templateName);
}
