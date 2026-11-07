import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { UnizeroBridge } from "../src/bridge";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
const files = { libraryID: 7, itemKey: "PAPER001", pdfs: [], artifacts: [], markdowns: [
  { key: "USER1", title: "Notes", purpose: "user", main: false },
] };

beforeEach(() => { vi.clearAllMocks(); });

describe("Markdown attachment capability", () => {
  it.each([true, false])("uses the expanded listing only when advertised: %s", async (supported) => {
    vi.mocked(requestUrl).mockImplementation((options) => {
      const url = typeof options === "string" ? options : options.url;
      const json = url.endsWith("/ping") ? { api: 2, capabilities: supported ? ["artifacts", "markdown-attachments"] : ["artifacts"] } : files;
      const response = { status: 200, headers: {}, text: JSON.stringify(json), json, arrayBuffer: new ArrayBuffer(0) };
      return Object.assign(Promise.resolve(response), {
        json: Promise.resolve(json), text: Promise.resolve(response.text), arrayBuffer: Promise.resolve(response.arrayBuffer),
      });
    });
    const listing = await new UnizeroBridge(() => "http://localhost:23119").artifacts({ libraryID: 7, itemKey: "PAPER001" });
    expect(listing.markdowns).toEqual(supported ? files.markdowns : undefined);
    expect(listing.artifacts).toEqual([]);
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://localhost:23119/unizero/v1/artifacts?libraryID=7&itemKey=PAPER001",
      method: "GET", headers: { "Zotero-Allowed-Request": "1" },
    }));
  });
});
