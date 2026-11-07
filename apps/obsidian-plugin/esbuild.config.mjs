import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

/**
 * Obsidian supplies these at runtime and rejects a plugin that bundles its own
 * copy of the CodeMirror packages: two CodeMirror instances in one editor do not
 * share state, and the decorations would silently stop applying.
 */
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...builtins,
];

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [{
    name: "document-link-worker",
    setup(build) {
      build.onResolve({ filter: /^unizero:link-worker$/ }, () => ({ path: "link-worker", namespace: "worker" }));
      build.onLoad({ filter: /.*/, namespace: "worker" }, async () => {
        // Neutral resolution avoids DOM-based character-entity decoding in the worker.
        const result = await esbuild.build({ entryPoints: ["src/documentLinks.worker.ts"],
          bundle: true, write: false, format: "iife", target: "es2018", minify: production, metafile: true,
          platform: "neutral", mainFields: ["module", "main"] });
        return { contents: `export default ${JSON.stringify(result.outputFiles[0].text)}`, loader: "js",
          watchFiles: Object.keys(result.metafile.inputs) };
      });
    },
  }],
  external,
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  process.exit(0);
}

await context.watch();
