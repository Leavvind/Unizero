/** Keep only finite coordinates owned by the requested Zotero library. */
export function graphPositionsForLibrary(
  libraryID: number,
  value: unknown,
): Record<string, number[]> {
  if (!value || typeof value !== "object") { return {}; }
  const prefix = `${libraryID}:`;
  const positions: Record<string, number[]> = {};
  for (const [nodeID, coordinates] of Object.entries(value)) {
    if (
      !nodeID.startsWith(prefix) ||
      !Array.isArray(coordinates) ||
      coordinates.length !== 2
    ) {
      continue;
    }
    const x = Number(coordinates[0]);
    const y = Number(coordinates[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      positions[nodeID] = [x, y];
    }
  }
  return positions;
}
