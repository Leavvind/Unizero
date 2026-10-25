/**
 * Write the add-on's version into the Obsidian plugin and stage those files.
 *
 * One tag releases both plugins, and this package.json is the only place a version
 * is chosen. release-it runs this after its bump so the plugin's manifest and
 * package files carry the real version in the repository, not a placeholder; the
 * staging matters because release-it only stages changes under this directory.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const addonDir = path.resolve(scriptDir, "..");
const pluginDir = path.resolve(addonDir, "../obsidian-plugin");
const { version } = JSON.parse(fs.readFileSync(path.join(addonDir, "package.json"), "utf8"));

const files = ["manifest.json", "package.json", "package-lock.json"].map((name) =>
  path.join(pluginDir, name),
);

for (const file of files) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  // The lockfile repeats the root package's version under `packages[""]`.
  if (json.packages?.[""]) {
    json.packages[""].version = version;
  }
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

execFileSync("git", ["add", "--", ...files], { stdio: "inherit" });
console.log(`Obsidian plugin version set to ${version}.`);
