import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { BridgeClient } from "../src/bridge.js";
import { createServer } from "../src/server.js";

const DIGEST = join(import.meta.dirname, "fixtures", "tables-digest.html");

const PAPER = {
  citekey: "bernard1989",
  citekeyPinned: false,
  ambiguous: false,
  libraryID: 1,
  itemKey: "AAAA1111",
  title: "Post-Earnings-Announcement Drift",
  authors: ["Victor Bernard", "Jacob Thomas"],
  year: "1989",
  itemType: "journalArticle",
  venue: "Journal of Accounting Research",
  doi: "10.2307/2491062",
  links: { zoteroSelect: "zotero://select/library/items/AAAA1111" },
};

const UNCONVERTED = { ...PAPER, citekey: "ball1968", itemKey: "BBBB2222", title: "An Empirical Evaluation" };
const UNSYNCED = { ...PAPER, citekey: "foster1977", itemKey: "CCCC3333", title: "Quarterly Accounting Data" };

interface Call { method: string; path: string; query: Record<string, string> }

async function fixtureFiles() {
  const dir = await mkdtemp(join(tmpdir(), "unizero-mcp-"));
  await mkdir(join(dir, "raw"));
  const raw = join(dir, "raw", "Raw.md");
  await writeFile(raw, [
    "# Drift [p1](zotero://open-pdf/library/items/PDFMAIN1?page=1)",
    "## Introduction",
    "SUE is standardized unexpected earnings.",
    "## Results [p9](zotero://open-pdf/library/items/PDFMAIN1?page=9)",
    "Drift persists for 60 days.",
  ].join("\n"));
  const appendix = join(dir, "raw", "Raw (appendix).md");
  await writeFile(appendix, "# Appendix\nRobustness only.\n");
  const refs = join(dir, "refs.json");
  await writeFile(refs, JSON.stringify({
    schema: "unizero.references/2",
    references: [
      { index: 1, raw: "Ball, R., Brown, P. (1968).", page: 30, identifiers: { doi: "10.2307/2490232" } },
      { index: 2, raw: "Foster, G. (1977).", page: 30, identifiers: {} },
    ],
  }));
  return { raw, appendix, refs };
}

function fakeBridge(files: Awaited<ReturnType<typeof fixtureFiles>>, calls: Call[]): typeof fetch {
  const artifacts = {
    libraryID: 1,
    itemKey: "AAAA1111",
    pdfs: [
      { key: "PDFMAIN1", title: "Bernard 1989.pdf", main: true },
      { key: "PDFAPPX1", title: "Appendix.pdf", main: false },
    ],
    artifacts: [
      { kind: "raw", key: "RAWAPPX1", title: "Raw (appendix)", contentType: "text/markdown", source: "PDFAPPX1", path: files.appendix },
      { kind: "raw", key: "RAWMAIN1", title: "Raw", contentType: "text/markdown", source: "PDFMAIN1", path: files.raw },
      { kind: "tables", key: "TABMAIN1", title: "ZoMiner Tables", contentType: "text/html", source: "PDFMAIN1", path: DIGEST },
      { kind: "references", key: "REFMAIN1", title: "ZoMiner References", contentType: "application/json", source: "PDFMAIN1", path: files.refs },
    ],
  };

  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams);
    const path = url.pathname.replace("/unizero/v1/", "");
    calls.push({ method: init?.method || "GET", path, query });
    expect((init?.headers as Record<string, string>)["Zotero-Allowed-Request"]).toBe("1");
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    const which = query.itemKey === "BBBB2222" || query.citekey === "ball1968" ? UNCONVERTED
      : query.itemKey === "AAAA1111" || query.citekey === "bernard1989" ? PAPER
      : query.itemKey === "CCCC3333" ? UNSYNCED
      : undefined;
    switch (path) {
      case "ping":
        return reply(200, { product: "unizero", addonVersion: "0.9.1", api: 2, capabilities: ["paper", "artifacts"], ready: true });
      case "paper":
        return which ? reply(200, which) : reply(404, { error: "no item matches" });
      case "suggest":
        return reply(200, {
          items: /drift/i.test(query.q)
            ? [{ libraryID: 1, itemKey: "AAAA1111", citekey: "bernard1989", title: PAPER.title, authors: PAPER.authors, year: "1989" }]
            : [],
        });
      case "artifacts":
        if (which === PAPER) { return reply(200, artifacts); }
        if (which === UNSYNCED) {
          // Zotero knows the attachment, but its file has not arrived on this machine.
          return reply(200, {
            libraryID: 1, itemKey: "CCCC3333", pdfs: [{ key: "PDFFOST1", title: "Foster.pdf", main: true }],
            artifacts: [{ kind: "raw", key: "RAWFOST1", title: "Raw", contentType: "text/markdown", source: "PDFFOST1" }],
          });
        }
        return reply(200, { libraryID: 1, itemKey: "BBBB2222", pdfs: [{ key: "PDFBALL1", title: "Ball.pdf", main: true }], artifacts: [] });
      case "relations":
        return reply(200, { libraryID: 1, itemKey: "AAAA1111", citekey: "bernard1989", kind: query.kind, loaded: false, source: "", total: 0, count: 0, hasMore: false, items: [] });
      case "convert":
        return reply(202, { accepted: true, libraryID: 1, itemKey: "BBBB2222", template: "paper-to-zotero-markdown", message: "Conversion started in Zotero." });
      default:
        return reply(404, { error: "unknown endpoint" });
    }
  }) as typeof fetch;
}

describe("MCP server", () => {
  const calls: Call[] = [];
  let client: Client;

  beforeAll(async () => {
    const files = await fixtureFiles();
    const server = createServer(new BridgeClient("http://127.0.0.1:23119", fakeBridge(files, calls)));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
  });

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string; mimeType?: string }>;
    return {
      content,
      isError: Boolean(result.isError),
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    };
  }

  it("lists the tools, marking only convert_paper as writing", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "convert_paper", "find_paper", "get_paper", "get_references", "get_relations",
      "get_table", "read_paper", "search_paper",
    ]);
    const writers = tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name);
    expect(writers).toEqual(["convert_paper"]);
  });

  it("overviews a paper from the main PDF's Raw, with tables and references", async () => {
    const { text } = await call("get_paper", { paper: "@1/AAAA1111" });
    expect(text).toContain("PAPER @1/AAAA1111 [bernard1989]");
    expect(text).toContain("RAW  from \"Bernard 1989.pdf\" (PDFMAIN1, opened by default)");
    expect(text).toContain("L4 p.9  ## Results");
    expect(text).toContain("t01 p.12  Table 3: SUE & returns <by decile>");
    expect(text).toContain("REFERENCES  2 extracted");
    expect(text).toContain("\"Appendix.pdf\" (PDFAPPX1): raw");
  });

  it("resolves free text through suggest and reads a section with pages", async () => {
    const { text } = await call("read_paper", { paper: "post earnings drift", section: "Results" });
    expect(text).toContain("LINES 4-5 of 5");
    expect(text).toContain("L5 p.9  Drift persists for 60 days.");
    expect(text).not.toContain("Introduction");
  });

  it("reads the Raw of a chosen supplement PDF", async () => {
    const { text } = await call("read_paper", { paper: "bernard1989", pdf: "PDFAPPX1" });
    expect(text).toContain("Robustness only.");
  });

  it("searches the text", async () => {
    const { text } = await call("search_paper", { paper: "@1/AAAA1111", pattern: "unexpected", context: 0 });
    expect(text).toContain("1 matching lines");
    expect(text).toContain("L3 p.1  SUE is standardized unexpected earnings.");
  });

  it("returns a table crop as an image", async () => {
    const { content } = await call("get_table", { paper: "@1/AAAA1111", table: "t01" });
    expect(content[0].text).toContain("PDF p.12");
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("pages through extracted references", async () => {
    const { text } = await call("get_references", { paper: "@1/AAAA1111", limit: 1 });
    expect(text).toContain("[1] p.30  Ball, R., Brown, P. (1968).  {doi:10.2307/2490232}");
    expect(text).toContain("continue with offset=1");
  });

  it("never asks providers unless fetch is set", async () => {
    const { text } = await call("get_relations", { paper: "@1/AAAA1111", kind: "citations" });
    expect(text).toContain("not cached");
    expect(calls.filter((c) => c.path === "relations").every((c) => c.query.fetch === undefined)).toBe(true);
  });

  it("explains a missing Raw instead of failing silently, then converts on request", async () => {
    const missing = await call("read_paper", { paper: "ball1968" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("has not been converted");
    expect(missing.text).toContain("\"Ball.pdf\" (PDFBALL1, opened by default): not converted");

    const started = await call("convert_paper", { paper: "@1/BBBB2222" });
    expect(started.text).toContain("Conversion started in Zotero.");
    expect(calls.some((c) => c.method === "POST" && c.path === "convert" && c.query.itemKey === "BBBB2222")).toBe(true);
  });

  it("reports a Raw whose file is not on this machine instead of reading it", async () => {
    const overview = await call("get_paper", { paper: "@1/CCCC3333" });
    expect(overview.text).toContain("attachment exists but its file is not on this machine");
    const read = await call("read_paper", { paper: "@1/CCCC3333" });
    expect(read.isError).toBe(true);
    expect(read.text).toContain("not on this machine");
  });

  it("reports an unknown paper", async () => {
    const { text, isError } = await call("get_paper", { paper: "nothing like this" });
    expect(isError).toBe(true);
    expect(text).toContain("Nothing in the Zotero library matches");
  });
});
