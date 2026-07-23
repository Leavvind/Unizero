/**
 * Conversion commands: send the selected Zotero items through the paper runtime,
 * then register the resulting artifacts back onto Zotero.
 *
 * Ported from the conversion half of ZoMiner's `modules/commands.js`, with
 * identical behaviour.
 */

import { runtimeClient } from "../../runtime-client/client";
import { ensure } from "../../runtime-client/process";
import type { JobState } from "../../runtime-client/contracts";
import {
  conversionPayload,
  conversionTargets,
  markConverted,
} from "../../zotero/conversionAdapter";
import { showError, startBatch, type ProgressLine } from "../../ui/progress";
import { reportServiceFailure } from "../../ui/notices";
import { getConversionPref } from "./settings";

/**
 * Job polling interval.
 *
 * The runtime is a single-worker queue and conversions take minutes; polling
 * harder makes nothing faster and only floods the log.
 */
const POLL_MS = 3000;

/** Progress lines have limited width, so the log tail must be truncated. */
function shorten(value: unknown, length: number): string {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Poll until the job reaches a terminal state.
 *
 * Only the last line of log_tail feeds the progress bar: what the user wants is
 * "still alive, and doing this"; the full log lives in server.log.
 */
async function pollJob(
  jobId: string,
  onUpdate: (text: string) => void,
): Promise<JobState> {
  for (;;) {
    await Zotero.Promise.delay(POLL_MS);
    const status = await runtimeClient.job(jobId, 1);
    if (status.status === "done" || status.status === "failed") { return status; }
    const tail = status.log_tail?.length
      ? status.log_tail[status.log_tail.length - 1]
      : status.status;
    onUpdate(shorten(tail, 80));
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
 * Convert the currently selected items.
 *
 * Processed one at a time rather than concurrently: the runtime is a single
 * worker anyway, so concurrent submissions only queue up while scrambling the
 * progress display. One failure does not stop the batch.
 */
export async function convertSelected(
  mainWindow: Window,
  templateId: string,
  templateName?: string,
): Promise<void> {
  const items = (mainWindow as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  if (!items.length) { return; }

  const targets = await conversionTargets(items);
  if (!targets.length) {
    showError("The selected items have no usable PDF attachment");
    return;
  }

  if (!(await ensure({ reportError: reportServiceFailure }))) { return; }

  const batch = startBatch(`UniZero — ${templateName || templateId || "Conversion template"}`);
  for (const target of targets) {
    const line: ProgressLine = batch.addLine(targetTitle(target));
    line.setProgress(10);
    try {
      const accepted = await runtimeClient.convert(
        conversionPayload(target, templateId),
      );
      ztoolkit.log(`job ${accepted.job_id} for ${targetTitle(target)}`);

      const final = await pollJob(accepted.job_id, (text) => line.setText(text));
      if (final.status !== "done") {
        line.setError();
        line.setText(`Failed: ${final.error || "unknown error"}`);
        continue;
      }

      line.setProgress(100);
      const result = final.result || {};
      line.setText(`Done: ${result.md_path || ""}`);
      await markConverted(target, result, {
        mdSnapshot: getConversionPref("mdSnapshot"),
      });
    } catch (error) {
      line.setError();
      line.setText(`Failed: ${error}`);
      ztoolkit.log(`job error: ${error}`);
    }
  }
  batch.finish();
}
