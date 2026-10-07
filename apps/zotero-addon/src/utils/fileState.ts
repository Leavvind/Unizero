/**
 * Shared `IOUtils` error classification for the add-on's file-backed stores.
 *
 * Only `NotFoundError` means "this file has never been written". `NotAllowedError`
 * is a permission failure, and treating it as a missing file is how a readable
 * store silently becomes an empty one: a repository would create a second Project
 * over live data, a sync checkpoint would restart a full re-download and re-upload,
 * and a cache would report a miss forever. Let it propagate so the failure is
 * visible instead of destructive.
 */
export function isMissingFile(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NotFoundError";
}
