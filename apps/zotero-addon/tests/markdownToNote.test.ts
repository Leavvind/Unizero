import { markdownToNoteHtml } from "../src/notes/markdownToNote";

// Expected strings are what Better Notes 3.3.3's md2html produces for the same
// input, up to equivalent character references.
describe("Markdown to note HTML", () => {
  it("renders headings, emphasis and links", async () => {
    expect(await markdownToNoteHtml("# Title\n\nSome *em* and [a link](https://x.org).")).toBe(
      '<h1>Title</h1>\n<p>Some <em>em</em> and <a href="https://x.org">a link</a>.</p>',
    );
  });

  it("writes math the way the note editor renders it", async () => {
    expect(await markdownToNoteHtml("Inline $a<b$ here.\n\n$$\nx^2\n$$")).toBe(
      '<p>Inline <span class="math">$a&lt;b$</span> here.</p>\n<pre class="math">$$x^2$$</pre>',
    );
  });

  it("flattens code blocks into plain text under pre", async () => {
    expect(await markdownToNoteHtml("```\nconst a = 1;\n```")).toBe(
      "<pre>const a = 1;</pre>",
    );
  });

  it("strikes through with a styled span", async () => {
    expect(await markdownToNoteHtml("~~gone~~")).toBe(
      '<p><span style="text-decoration: line-through">gone</span></p>',
    );
  });

  it("unwraps the table header into the body", async () => {
    const html = await markdownToNoteHtml("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).not.toContain("thead");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td><span>1</span></td>");
  });

  it("wraps list text in spans", async () => {
    expect(await markdownToNoteHtml("- one\n- two")).toBe(
      "<ul>\n<li><span>one</span></li>\n<li><span>two</span></li>\n</ul>",
    );
  });

  it("passes HTML tables from the converter through", async () => {
    expect(await markdownToNoteHtml("<table><tr><td>x</td></tr></table>")).toBe(
      "<table><tr><td>x</td></tr></table>",
    );
  });

  it("drops images, keeping alt text and no stray breaks", async () => {
    expect(await markdownToNoteHtml("![](images/a.jpg)\n\nText")).toBe("<p>Text</p>");
    expect(await markdownToNoteHtml("![](images/a.jpg)  \nPanel A")).toBe("<p>Panel A</p>");
    expect(await markdownToNoteHtml("Before  \n![](a.jpg)  \nAfter")).toBe(
      "<p>Before<br>\nAfter</p>",
    );
    expect(await markdownToNoteHtml("![](a.jpg)![](b.jpg)")).toBe("");
    expect(await markdownToNoteHtml("See ![Figure 1](a.jpg).")).toBe("<p>See Figure 1.</p>");
  });

  it("keeps page links from the converter", async () => {
    expect(await markdownToNoteHtml("[p3](zotero://open-pdf/library/items/ABCD1234?page=3)")).toBe(
      '<p><a href="zotero://open-pdf/library/items/ABCD1234?page=3">p3</a></p>',
    );
  });
});
