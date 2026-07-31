/**
 * Locale-independent string ordering for persisted and content-addressed data.
 *
 * `localeCompare` depends on the host locale and ICU version. That is correct
 * for text shown to a user and wrong for anything a checksum, an object ID, a
 * persisted index key, or a cross-device comparison depends on: two devices
 * would disagree about identical data.
 *
 * The same reasoning applies to case folding, which is why these code paths
 * call `toLowerCase` rather than `toLocaleLowerCase` — under a Turkish or Azeri
 * locale the latter maps `I` to `ı` and silently changes a stored identifier.
 */

/** Compare by UTF-16 code unit, matching the `<` and `>` operators. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) { return -1; }
  return left > right ? 1 : 0;
}
