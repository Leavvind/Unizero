import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { build } from "esbuild";

// `obsidian` and `electron` exist only inside the Obsidian app; tests that import
// code using them resolve to an empty module and supply behaviour with `vi.mock`.
const hostStub = fileURLToPath(new URL("./tests/hostStub.ts", import.meta.url));

export default defineConfig({
  plugins: [{
    name: "test-document-link-worker",
    resolveId(id) { if (id === "unizero:link-worker") { return id; } },
    async load(id) {
      if (id !== "unizero:link-worker") { return; }
      const result = await build({ entryPoints: [fileURLToPath(new URL("./src/documentLinks.worker.ts", import.meta.url))],
        bundle: true, write: false, format: "iife", target: "es2018", platform: "neutral", mainFields: ["module", "main"] });
      return `export default ${JSON.stringify(result.outputFiles[0].text)}`;
    },
  }],
  resolve: {
    alias: {
      obsidian: hostStub,
      electron: hostStub,
    },
  },
});
