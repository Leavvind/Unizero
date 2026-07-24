import { defineConfig } from "vitest/config";

// Unit tests target pure logic (the derived UniConnection graph). The source
// modules assume a privileged Zotero runtime, so tests stub the few globals they
// touch (tests/setup.ts) and mock the side-effectful singletons (localStorage) at
// the module boundary. No DOM is needed, so the environment stays "node".
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
