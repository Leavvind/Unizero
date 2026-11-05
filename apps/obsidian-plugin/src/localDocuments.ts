import { readFile, open, rename, unlink, stat } from "fs/promises";
import { randomUUID } from "crypto";
import { contentHash } from "./externalIndex";

/** Replace an existing declared attachment after a final revision check. */
export async function replaceLocalDocument(path: string, expected: string, content: string): Promise<void> {
  const previous = await stat(path);
  if (!previous.isFile() || contentHash(await readFile(path, "utf8")) !== contentHash(expected)) {
    throw new Error("The attachment changed; generate a new preview or reopen the file.");
  }
  const temporary = `${path}.unizero-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", previous.mode);
  try {
    await handle.writeFile(content, "utf8"); await handle.sync(); await handle.close();
    const current = await stat(path);
    if (current.ino !== previous.ino || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs
      || contentHash(await readFile(path, "utf8")) !== contentHash(expected)) {
      throw new Error("The attachment changed during the operation; nothing was replaced.");
    }
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
