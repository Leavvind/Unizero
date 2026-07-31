import {
  parseWebDAVMultiStatus,
  WebDAVBackend,
} from "../src/sync/webdavBackend";

function xhr(body = "", headers: Record<string, string> = {}) {
  return {
    responseText: body,
    getResponseHeader: (name: string) => headers[name],
  };
}

describe("WebDAVBackend", () => {
  beforeEach(() => {
    (globalThis as any).Zotero.HTTP = {
      request: vi.fn(async () => xhr()),
    };
  });

  it("requires HTTPS and never places credentials in the URL", async () => {
    expect(() => new WebDAVBackend({
      baseURL: "http://dav.example.test/dav/",
      username: "person@example.test",
      password: "secret",
    })).toThrow("must use HTTPS");

    const backend = new WebDAVBackend({
      baseURL: "https://dav.example.test/dav/",
      username: "person@example.test",
      password: "app-password",
    });
    await backend.connect();
    const calls = (Zotero.HTTP.request as any).mock.calls;
    expect(calls[0][1]).toBe("https://dav.example.test/dav/Unizero");
    expect(calls[0][2].headers.Authorization).toBe(
      "Basic cGVyc29uQGV4YW1wbGUudGVzdDphcHAtcGFzc3dvcmQ=",
    );
    expect(JSON.stringify(calls)).not.toContain("app-password");
    expect(JSON.stringify(calls)).not.toContain("person@example.test@");
    expect(() => new WebDAVBackend({
      baseURL: "https://dav.example.test/dav/",
      username: "person@example.test",
      password: "secret",
      remoteRoot: "Unizero/%2e%2e/private",
    })).toThrow("path traversal");
  });

  it("creates parent collections and sends conditional PUT headers", async () => {
    const backend = new WebDAVBackend({
      baseURL: "https://dav.example.test/dav/",
      username: "person@example.test",
      password: "app-password",
    });
    await backend.connect();
    await backend.put("objects/project.meta/ab/project_1.json", "{}", {
      ifNoneMatch: true,
    });

    const calls = (Zotero.HTTP.request as any).mock.calls;
    const put = calls.find((call: any[]) => call[0] === "PUT");
    expect(put[1]).toBe(
      "https://dav.example.test/dav/Unizero/v1/objects/" +
      "project.meta/ab/project_1.json",
    );
    expect(put[2].headers["If-None-Match"]).toBe("*");
    expect(put[2].headers.Authorization).toMatch(/^Basic /);
  });

  it("treats GET 404 as a cache miss", async () => {
    (Zotero.HTTP.request as any).mockRejectedValue({
      xmlhttp: { status: 404 },
    });
    const backend = new WebDAVBackend({
      baseURL: "https://dav.example.test/dav/",
      username: "person@example.test",
      password: "app-password",
    });
    expect(await backend.get("missing.json")).toBeUndefined();
  });

  it("explains rejected WebDAV credentials without exposing them", async () => {
    (Zotero.HTTP.request as any).mockRejectedValue({
      xmlhttp: { status: 401 },
    });
    const backend = new WebDAVBackend({
      baseURL: "https://dav.example.test/dav/",
      username: "person@example.test",
      password: "app-password",
    });

    await expect(backend.connect()).rejects.toMatchObject({
      name: "WebDAVError",
      status: 401,
      message: expect.stringContaining("third-party application password"),
    });
    try {
      await backend.connect();
    } catch (error) {
      expect(String(error)).not.toContain("app-password");
    }
  });

  it("parses direct child files and collections from a multistatus response", () => {
    const body = `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/dav/Unizero/v1/devices/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/>
          </d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/dav/Unizero/v1/devices/device-a/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/>
          </d:resourcetype><d:getetag>"a"</d:getetag></d:prop></d:propstat>
        </d:response>
        <d:response><d:href>/dav/Unizero/v1/devices/index.json</d:href>
          <d:propstat><d:prop><d:resourcetype/>
          <d:getetag>"b"</d:getetag></d:prop></d:propstat></d:response>
      </d:multistatus>`;
    expect(parseWebDAVMultiStatus(
      body,
      "https://dav.example.test/dav/Unizero/v1/devices/",
    )).toEqual([
      expect.objectContaining({
        key: "device-a",
        collection: true,
        revision: "\"a\"",
      }),
      expect.objectContaining({
        key: "index.json",
        collection: false,
        revision: "\"b\"",
      }),
    ]);
  });
});
