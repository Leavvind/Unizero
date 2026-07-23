import process from "process";
import { execSync } from "child_process";
import { readFileSync } from "fs";
const cmd = JSON.parse(
  readFileSync(new URL("./zotero-cmd.json", import.meta.url), "utf8"),
);
const { killZoteroWindows, killZoteroUnix } = cmd;

try {
  if (process.platform === "win32") {
    execSync(killZoteroWindows);
  } else {
    execSync(killZoteroUnix);
  }
} catch (e) {
  console.error(e);
}
