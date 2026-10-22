import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `obsidian` and `electron` exist only inside the Obsidian app; tests that import
// code using them resolve to an empty module and supply behaviour with `vi.mock`.
const hostStub = fileURLToPath(new URL("./tests/hostStub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      obsidian: hostStub,
      electron: hostStub,
    },
  },
});
