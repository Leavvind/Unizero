/**
 * 转换命令：把选中的 Zotero 条目送进 paper runtime，再把产物登记回 Zotero。
 *
 * 端口自 ZoMiner `modules/commands.js` 的转换部分，行为保持一致。
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
import { getConversionPref } from "./settings";

/**
 * job 轮询间隔。
 *
 * runtime 是单 worker 队列，转换以分钟计；轮询再密也不会更快，只会把日志刷满。
 */
const POLL_MS = 3000;

/** 进度行宽度有限，日志尾巴要截断。 */
function shorten(value: unknown, length: number): string {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * 轮询到 job 终态。
 *
 * 只取 log_tail 的最后一行喂给进度条：用户要的是"还活着、正在做什么"，
 * 完整日志在 server.log 里。
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
 * 转换当前选中的条目。
 *
 * 逐个串行处理而不是并发：runtime 本来就是单 worker，并发提交只会让所有 job 排队，
 * 同时把进度显示搅成一团。单个失败不中断整批。
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
    showError("选中的条目没有可用的 PDF 附件");
    return;
  }

  if (!(await ensure({ reportError: showError }))) { return; }

  const batch = startBatch(`UniZero — ${templateName || templateId || "转换模板"}`);
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
        line.setText(`失败: ${final.error || "未知错误"}`);
        continue;
      }

      line.setProgress(100);
      const result = final.result || {};
      line.setText(`完成: ${result.md_path || ""}`);
      await markConverted(target, result, {
        mdSnapshot: getConversionPref("mdSnapshot"),
      });
    } catch (error) {
      line.setError();
      line.setText(`失败: ${error}`);
      ztoolkit.log(`job error: ${error}`);
    }
  }
  batch.finish();
}
