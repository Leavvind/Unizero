/**
 * Session notice log, rendered by the panel inside the Jobs list.
 *
 * The panel used to carry a Service status card with Start/Stop buttons. The service
 * now starts and stops with Zotero, so there is nothing left to operate — but the
 * failures that card reported still have to reach someone. They land here, and the
 * panel shows them alongside the runtime's own jobs.
 *
 * Why the add-on keeps them instead of the runtime: the two failures that matter most
 * — the service refusing to start, and the service disappearing mid-session — are
 * exactly the cases where there is no runtime left to ask. Notices are therefore held
 * in memory for the Zotero session and never persisted; a problem that outlives a
 * restart reports itself again on the next start.
 */

import { showError } from "./progress";

/** Notices are a diagnostic tail, not a log: only the recent ones are worth keeping. */
const MAX_NOTICES = 20;

/** Default title. Shared by every local-service notice so repeats collapse onto one row. */
const SERVICE_TITLE = "Local conversion service";

/** Default title for conversion failures that never became a runtime job. */
const CONVERSION_TITLE = "Markdown conversion";

export interface ServiceNotice {
  id: string;
  /** Unix seconds, like the runtime's job `created`, so the panel can sort one merged list. */
  created: number;
  title: string;
  /** Same vocabulary as JobStatus, so the panel styles jobs and notices identically. */
  status: "failed";
  detail: string;
  /** True when starting the service again is a sensible next step for the user. */
  retryable: boolean;
}

export interface NoticeInput {
  title?: string;
  detail: string;
  retryable?: boolean;
}

let notices: ServiceNotice[] = [];
let sequence = 0;

/**
 * Record a notice, replacing any existing one with the same title.
 *
 * Collapsing by title is deliberate: a service that will not start says the same thing
 * on every retry, and twenty copies of one problem bury the jobs underneath it.
 *
 * Fields are copied one by one rather than spread from the input: the panel runs in
 * its own window and passes its objects back through this function, so what arrives
 * is not necessarily the shape declared above.
 */
export function pushNotice(input: NoticeInput): ServiceNotice {
  const notice: ServiceNotice = {
    id: `notice-${++sequence}`,
    created: Date.now() / 1000,
    title: String(input?.title || SERVICE_TITLE),
    status: "failed",
    detail: String(input?.detail || ""),
    retryable: input?.retryable !== false,
  };
  notices = [notice, ...notices.filter((existing) => existing.title !== notice.title)]
    .slice(0, MAX_NOTICES);
  return notice;
}

/** Newest first, matching the runtime's job ordering. */
export function listNotices(): ServiceNotice[] {
  return notices.map((notice) => ({ ...notice }));
}

export function dismissNotice(id: string): void {
  notices = notices.filter((notice) => notice.id !== id);
}

/**
 * Report a failure nobody asked for — the automatic start, or the service vanishing.
 *
 * Nothing interrupts the user: a local service that is only needed for conversion has
 * no business throwing a popup over an unrelated Zotero session. The panel holds the
 * reason for whenever the user goes looking.
 */
export function noteServiceFailure(message: string): void {
  ztoolkit.log(`service notice: ${message}`);
  pushNotice({ detail: message });
}

/**
 * Report a failure of something the user just asked for.
 *
 * The popup answers the click; the notice keeps the reason readable after the popup
 * has timed out and the user opens the panel to find out what happened.
 */
export function reportServiceFailure(message: string): void {
  showError(message);
  noteServiceFailure(message);
}

/**
 * Report a conversion problem the runtime's own job list cannot show — a request it
 * never accepted, or the Zotero-side bookkeeping that follows a finished job.
 *
 * `title` is the affected item, so one row per item survives; the default covers the
 * failures that belong to the batch rather than to any one item. Never retryable:
 * starting the service again is not what fixes a missing PDF or a rejected request.
 */
export function noteConversionFailure(detail: string, title?: string): void {
  ztoolkit.log(`conversion notice: ${detail}`);
  pushNotice({ title: title || CONVERSION_TITLE, detail, retryable: false });
}
