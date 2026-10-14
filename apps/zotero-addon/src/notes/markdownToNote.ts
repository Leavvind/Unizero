/**
 * Markdown to Zotero note HTML, without Better Notes.
 *
 * Ported from Better Notes 3.3.3 (windingwind/zotero-better-notes, commit 4215a88,
 * AGPL-3.0), `src/extras/convert.ts`: `md2remark`, `remark2rehype`, `rehype2note`
 * and `md2html`. The note-editor rules in `rehypeToNote` are theirs; keep them in
 * step with upstream fixes rather than rewriting them.
 *
 * Differences from upstream, all deliberate:
 * - images are dropped, keeping any alt text: Raw notes carry no images, and a
 *   relative `images/…` path cannot render inside a Zotero note;
 * - `parseKatexHTML` is not ported: converted papers contain TeX, not KaTeX HTML;
 * - it runs on the calling thread rather than in a Worker.
 *
 * Pure: no Zotero, DOM, or file-system access, so it is unit-tested directly.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { visitParents } from "unist-util-visit-parents";
import { toText } from "hast-util-to-text";
import { toHtml } from "hast-util-to-html";
import type { Root as HRoot, RootContent, Nodes } from "hast";
import type { Root as MRoot } from "mdast";

// Unified processors are stateless once built, so build each one once.
const markdownParser = unified().use(remarkGfm).use(remarkMath).use(remarkParse);
const markdownToHast = unified().use(remarkRehype, { allowDangerousHtml: true });
const noteStringifier = unified().use(rehypeStringify, {
  allowDangerousCharacters: true,
  allowDangerousHtml: true,
  // Upstream re-serialises through DOMParser, which writes `&amp;`, not `&#x26;`
  characterReferences: { useNamedReferences: true },
});

export async function markdownToNoteHtml(markdown: string): Promise<string> {
  const mdast = markdownParser.parse(markdown) as MRoot;
  dropImages(mdast);
  const hast = await markdownToHast.run(mdast as any) as HRoot;
  restoreMathSpans(hast);
  return rehypeToNote(hast);
}

/**
 * Replace each image with its alt text. Only the parents that held an image are
 * tidied: the line breaks that framed the image go with it, and a paragraph left
 * empty is removed.
 */
function dropImages(mdast: MRoot): void {
  // Collected first: splicing during a visit skips the next sibling
  const parents = new Map<any, any>();
  visitParents(mdast, (node: any) => node.type === "image" || node.type === "imageReference",
    (_node: any, ancestors: any[]) => {
      parents.set(ancestors[ancestors.length - 1], ancestors[ancestors.length - 2]);
    });

  const isBreak = (node: any) =>
    node.type === "break" || (node.type === "text" && !node.value.trim());
  for (const [parent, grandparent] of parents) {
    const children: any[] = [];
    for (const child of parent.children) {
      if (child.type !== "image" && child.type !== "imageReference") {
        children.push(child);
        continue;
      }
      const alt = (child.alt || "").trim();
      if (alt) { children.push({ type: "text", value: alt }); }
    }
    while (children.length && isBreak(children[0])) { children.shift(); }
    while (children.length && isBreak(children[children.length - 1])) { children.pop(); }
    // A removed image between two breaks leaves them adjacent: keep one
    const tidy: any[] = [];
    for (const child of children) {
      const lastSolid = [...tidy].reverse()
        .find((kept) => !(kept.type === "text" && !kept.value.trim()));
      if (child.type === "break" && lastSolid?.type === "break") { continue; }
      tidy.push(child);
    }
    parent.children = tidy;
    if (!parent.children.length && parent.type === "paragraph" && grandparent) {
      grandparent.children.splice(grandparent.children.indexOf(parent), 1);
    }
  }
}

/**
 * remark-math v6 emits `<code class="language-math math-inline">` and
 * `<pre><code class="language-math math-display">`. Restore the flat
 * `<span class="math-inline/math-display">` shape `rehypeToNote` expects, or its
 * code-block visitor consumes display math.
 */
function restoreMathSpans(hast: HRoot): void {
  visit(
    hast,
    (node: any) =>
      node.type === "element" &&
      node.tagName === "pre" &&
      node.children?.[0]?.properties?.className?.includes("math-display"),
    (node: any) => {
      const code = node.children[0];
      node.tagName = "span";
      node.properties = { className: ["math-display"] };
      node.children = code.children;
    },
  );
  visit(
    hast,
    (node: any) =>
      node.type === "element" &&
      node.tagName === "code" &&
      node.properties?.className?.includes("math-inline"),
    (node: any) => {
      node.tagName = "span";
      node.properties = { className: ["math-inline"] };
    },
  );
}

/** Reshape generic HTML into what Zotero's note-editor schema accepts. */
function rehypeToNote(rehype: HRoot): string {
  // Strikethrough
  visit(
    rehype,
    (node: any) => node.type === "element" && node.tagName === "del",
    (node: any) => {
      node.tagName = "span";
      node.properties.style = "text-decoration: line-through";
    },
  );

  // Code blocks: the editor wants plain text directly under <pre>
  visitParents(
    rehype,
    (node: any) => node.type === "element" && node.tagName === "code",
    (node: any, ancestors: any[]) => {
      const parent = ancestors[ancestors.length - 1];
      if (parent?.type === "element" && parent?.tagName === "pre") {
        node.value = toText(node, { whitespace: "pre-wrap" });
        if (node.value.endsWith("\n")) {
          node.value = node.value.slice(0, -1);
        }
        node.type = "text";
      }
    },
  );

  // Tables: keep styled ones verbatim, drop a placeholder header row
  visit(
    rehype,
    (node: any) => node.type === "element" && node.tagName === "table",
    (node: any) => {
      let hasStyle = false;
      let hasHeader = false;
      visit(
        node,
        (cell: any) => cell.type === "element" && ["tr", "td", "th"].includes(cell.tagName),
        (cell: any) => {
          if (cell.properties.style) {
            hasStyle = true;
          }
          if (!hasHeader && cell.tagName === "th" && cell.children[0]?.value !== "<!-- -->") {
            hasHeader = true;
          }
        },
      );
      if (hasStyle) {
        node.value = toHtml(node, { allowDangerousHtml: true }).replace(/[\r\n]/g, "");
        node.children = [];
        node.type = "raw";
      }
      if (!hasHeader) {
        const index = node.children.findIndex((child: any) => child.tagName === "thead");
        if (index > -1) {
          node.children = node.children.slice(index + 1);
        }
      }
    },
  );

  // The editor has no thead: unwrap it into the body
  visit(
    rehype,
    (node: any) => node.type === "element" && node.tagName === "thead",
    (node: any) => {
      node.value = toHtml(node, { allowDangerousHtml: true }).slice(7, -8);
      node.children = [];
      node.type = "raw";
    },
  );

  // Text directly inside list items and cells is wrapped in <span>
  visitParents(rehype, "text", (node: any, ancestors: any[]) => {
    const parent = ancestors[ancestors.length - 1];
    if (
      parent?.type === "element" &&
      ["li", "td"].includes(parent?.tagName) &&
      node.value.replace(/[\r\n]/g, "")
    ) {
      node.type = "element";
      node.tagName = "span";
      node.children = [{ type: "text", value: node.value.replace(/[\r\n]/g, "") }];
      node.value = undefined;
    }
  });

  // No line-break-only text in list items and cells
  visit(
    rehype,
    (node: any) => node.type === "element" && (node.tagName === "li" || node.tagName === "td"),
    (node: any) => {
      // Only line-break-only text goes: inline HTML is still a `raw` node here
      node.children = node.children.filter(
        (child: any) => child.type !== "text" || child.value.replace(/[\r\n]/g, ""),
      );

      // Inline math in a list item: drop one space from each neighbouring text
      // (Better Notes #1300)
      if (node.tagName === "li") {
        for (const p of node.children) {
          if (!p.children) { continue; }
          for (let idx = 0; idx < p.children.length; idx++) {
            if (!p.children[idx].properties?.className?.includes("math-inline")) { continue; }
            if (idx > 0) {
              const prev = p.children[idx - 1];
              if (prev.type === "text" && prev.value.endsWith(" ")) {
                prev.value = prev.value.slice(0, -1);
              }
            }
            if (idx < p.children.length - 1) {
              const next = p.children[idx + 1];
              if (next.type === "text" && next.value.startsWith(" ")) {
                next.value = next.value.slice(1);
              }
            }
          }
        }
      }
    },
  );

  // Math: the editor renders <span class="math">$…$</span> and <pre class="math">$$…$$</pre>
  visit(
    rehype,
    (node: any) =>
      node.type === "element" &&
      (node.properties?.className?.includes("math-inline") ||
        node.properties?.className?.includes("math-display")),
    (node: any) => {
      if (node.properties.className.includes("math-inline")) {
        node.children = [
          { type: "text", value: "$" },
          ...node.children,
          { type: "text", value: "$" },
        ];
      } else {
        node.children = [
          { type: "text", value: "$$" },
          ...node.children,
          { type: "text", value: "$$" },
        ];
        node.tagName = "pre";
      }
      node.properties.className = "math";
    },
  );

  // The editor does not keep rel on links
  visit(
    rehype,
    (node: any) => node.type === "element" && node.tagName === "a",
    (node: any) => {
      node.properties.rel = undefined;
    },
  );

  // Collapse runs of empty lines
  const kept: RootContent[] = [];
  const isEmpty = (node: Nodes) =>
    (node.type === "text" && !node.value.trim()) ||
    (node.type === "element" && node.tagName === "p" && !node.children.length && !toText(node).trim());
  for (const child of rehype.children) {
    if (kept.length && isEmpty(kept[kept.length - 1] as Nodes) && isEmpty(child as Nodes)) {
      continue;
    }
    kept.push(child);
  }
  rehype.children = kept;

  return noteStringifier.stringify(rehype as any);
}
