/** Update stored Canvas paths from a vault file or folder rename event. */
export function renameCanvasLinks(
  links: Record<string, string>,
  oldPath: string,
  newPath: string,
  isFolder: boolean,
): boolean {
  if (oldPath === newPath) { return false; }
  let changed = false;
  const prefix = `${oldPath}/`;
  for (const [key, path] of Object.entries(links)) {
    if (typeof path !== "string") { continue; }
    if (path === oldPath || (isFolder && path.startsWith(prefix))) {
      links[key] = newPath + path.slice(oldPath.length);
      changed = true;
    }
  }
  return changed;
}
