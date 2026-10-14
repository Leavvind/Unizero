/**
 * Cut Markdown into pieces at structural boundaries, for Raw notes too long to sync.
 *
 * Pure: no Zotero APIs. Cuts happen only before a heading or at a blank line, and
 * never inside a fenced code block or a `$$` math block, so every piece renders the
 * same on its own as it did inside the whole document.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MATH_FENCE = /^\s{0,3}\$\$/;

/**
 * Whether each line sits inside a code or math block (opening and closing lines
 * included), where a `#` line is not a heading and a blank line is not a break.
 */
function blockedLines(lines: string[]): boolean[] {
  const blocked: boolean[] = [];
  let fence = "";
  let math = false;
  for (const line of lines) {
    if (fence) {
      blocked.push(true);
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length &&
          !line.slice(close[0].length).trim()) {
        fence = "";
      }
      continue;
    }
    if (math) {
      blocked.push(true);
      if (line.includes("$$")) { math = false; }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = open[1];
      blocked.push(true);
      continue;
    }
    if (MATH_FENCE.test(line)) {
      // `$$ x $$` on one line opens and closes the block.
      math = line.trim().length <= 2 || !line.trim().slice(2).includes("$$");
      blocked.push(true);
      continue;
    }
    blocked.push(false);
  }
  return blocked;
}

function cutBefore(lines: string[], starts: number[]): string[] {
  const pieces: string[] = [];
  let from = 0;
  for (const start of starts) {
    if (start > from) { pieces.push(lines.slice(from, start).join("\n")); }
    from = start;
  }
  pieces.push(lines.slice(from).join("\n"));
  return pieces.filter((piece) => piece.trim());
}

/**
 * Split before every ATX heading of exactly `level`. Text before the first such
 * heading is its own piece.
 */
export function splitAtHeadings(markdown: string, level: number): string[] {
  const lines = markdown.split("\n");
  const blocked = blockedLines(lines);
  const heading = new RegExp(`^\\s{0,3}#{${level}}(?:[ \\t]|$)`);
  const starts = lines
    .map((line, index) => (!blocked[index] && heading.test(line) ? index : -1))
    .filter((index) => index > 0);
  return cutBefore(lines, starts);
}

/** Split at blank lines outside code and math blocks: the paragraph fallback. */
export function splitAtParagraphs(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocked = blockedLines(lines);
  const starts: number[] = [];
  for (let index = 1; index < lines.length; index++) {
    if (!blocked[index] && lines[index].trim() &&
        !blocked[index - 1] && !lines[index - 1].trim()) {
      starts.push(index);
    }
  }
  return cutBefore(lines, starts);
}

/** Text of the first heading in a piece, without the `#` marks or emphasis. */
export function firstHeading(markdown: string): string {
  const lines = markdown.split("\n");
  const blocked = blockedLines(lines);
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s{0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(lines[index]);
    if (!blocked[index] && match && match[1].trim()) {
      return match[1].replace(/[*_`]/g, "").trim();
    }
  }
  return "";
}
