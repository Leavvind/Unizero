/**
 * 批注注入命令：把 Zotero 里的高亮/下划线注入到已生成的 Markdown。
 *
 * 端口自 ZoMiner `modules/commands.js` 的批注部分，行为保持一致。
 *
 * 注入是幂等的：runtime 用批注 key 做标记，重复运行只会补上新增的那些。
 */

import { runtimeClient } from "../../runtime-client/client";
import { ensure } from "../../runtime-client/process";
import { annotationPayload, regularParents } from "../../zotero/annotationAdapter";
import { showError, startBatch } from "../../ui/progress";

/** 把 runtime 的注入统计说成人话。 */
function describeResult(result: {
  injected: number;
  total: number;
  already?: number;
  skipped?: unknown[];
}): string {
  let message = `注入 ${result.injected}/${result.total}`;
  if (result.already) { message += `（已存在 ${result.already}）`; }
  if (result.skipped?.length) { message += `，未匹配 ${result.skipped.length}`; }
  return message;
}

export async function annotateSelected(mainWindow: Window): Promise<void> {
  const items = (mainWindow as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  if (!items.length) { return; }

  const parents = regularParents(items);
  if (!parents.length) {
    showError("请选择文献条目");
    return;
  }

  if (!(await ensure({ reportError: showError }))) { return; }

  const batch = startBatch("UniZero — 批注注入");
  for (const parent of parents) {
    const title = parent.getField("title");
    const line = batch.addLine(title);
    line.setProgress(30);
    try {
      const payload = annotationPayload(parent);
      // 没有可注入的批注不是错误：用户可能只是还没读这篇。
      if (!payload.annotations.length) {
        line.setProgress(100);
        line.setText(`无可注入批注（仅支持高亮/下划线）: ${title}`);
        continue;
      }
      const result = await runtimeClient.annotate(payload);
      line.setProgress(100);
      line.setText(`${describeResult(result)}: ${title}`);
    } catch (error) {
      line.setError();
      line.setText(`失败: ${error}`);
      ztoolkit.log(`annotate error: ${error}`);
    }
  }
  batch.finish();
}
