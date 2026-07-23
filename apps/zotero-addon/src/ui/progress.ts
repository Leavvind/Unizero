/**
 * ProgressWindow 的薄封装。
 *
 * 单独抽出来是为了让功能模块不必直接依赖 Zotero 的进度窗口 API——按 AGENTS.md，
 * UI 是适配器，业务代码只应该说"报个错""更新这行文字"。
 */

const ERROR_CLOSE_MS = 6000;
const BATCH_CLOSE_MS = 8000;

/** 一次性错误提示。点击即关，或到时自动关。 */
export function showError(message: string): void {
  const progress = new Zotero.ProgressWindow({ closeOnClick: true });
  progress.changeHeadline("UniZero");
  const line = new progress.ItemProgress("", message);
  line.setError();
  progress.show();
  progress.startCloseTimer(ERROR_CLOSE_MS);
}

/** 批处理进度里的一行，对应一个被处理的条目。 */
export interface ProgressLine {
  setProgress(percent: number): void;
  setText(text: string): void;
  setError(): void;
}

export interface BatchProgress {
  addLine(title: string): ProgressLine;
  /** 结束展示。所有行都已终态时调用。 */
  finish(): void;
}

/**
 * 多条目批处理进度窗口。
 *
 * 不自动关闭而是留 8 秒：批量转换的结果（成功路径、失败原因）是用户唯一能看到的
 * 反馈，立刻消失等于没报告。
 */
export function startBatch(headline: string): BatchProgress {
  const progress = new Zotero.ProgressWindow({ closeOnClick: false });
  progress.changeHeadline(headline);
  progress.show();

  return {
    addLine(title: string): ProgressLine {
      return new progress.ItemProgress("", title) as ProgressLine;
    },
    finish(): void {
      progress.startCloseTimer(BATCH_CLOSE_MS);
    },
  };
}
