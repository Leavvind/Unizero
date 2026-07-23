/**
 * Thin wrapper around ProgressWindow.
 *
 * Extracted so feature modules never depend on Zotero's progress-window API
 * directly — per AGENTS.md the UI is an adapter, and business code should only
 * have to say "report an error" or "update this line".
 */

const ERROR_CLOSE_MS = 6000;
const BATCH_CLOSE_MS = 8000;

/** One-off error notice. Closes on click, or automatically when the timer expires. */
export function showError(message: string): void {
  const progress = new Zotero.ProgressWindow({ closeOnClick: true });
  progress.changeHeadline("UniZero");
  const line = new progress.ItemProgress("", message);
  line.setError();
  progress.show();
  progress.startCloseTimer(ERROR_CLOSE_MS);
}

/** One line of batch progress, corresponding to one processed item. */
export interface ProgressLine {
  setProgress(percent: number): void;
  setText(text: string): void;
  setError(): void;
}

export interface BatchProgress {
  addLine(title: string): ProgressLine;
  /** End the display. Called once every line has reached a terminal state. */
  finish(): void;
}

/**
 * Progress window for a multi-item batch.
 *
 * It lingers for eight seconds instead of closing at once: the outcome of a batch
 * conversion — the success paths and the failure reasons — is the only feedback
 * the user gets, and vanishing immediately is the same as not reporting it.
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
