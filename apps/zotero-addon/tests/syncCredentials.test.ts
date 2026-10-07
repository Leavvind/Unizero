import {
  getWebDAVPassword,
  removeWebDAVPassword,
  saveWebDAVPassword,
} from "../src/sync/credentials";

describe("WebDAV credential storage", () => {
  const logins: any[] = [];

  beforeEach(() => {
    logins.length = 0;
    (globalThis as any).Services = {
      logins: {
        searchLoginsAsync: vi.fn(async ({ origin, httpRealm }) =>
          logins.filter((login) =>
            login.origin === origin && login.httpRealm === httpRealm)),
        addLoginAsync: vi.fn(async (login) => {
          logins.push(login);
        }),
        removeLogin: vi.fn((login) => {
          const index = logins.indexOf(login);
          if (index >= 0) { logins.splice(index, 1); }
        }),
      },
    };
    (globalThis as any).Components = {
      interfaces: { nsILoginInfo: {} },
      Constructor: vi.fn(function () {
        return function (
          this: any,
          origin: string,
          _formSubmitURL: unknown,
          httpRealm: string,
          username: string,
          password: string,
        ) {
          Object.assign(this, {
            origin,
            httpRealm,
            username,
            password,
          });
        };
      }),
    };
  });

  it("stores and retrieves a secret in a server-scoped Login Manager realm", async () => {
    await saveWebDAVPassword(
      "https://dav.jianguoyun.com/dav/",
      "person@example.test",
      " app-password ",
    );

    expect(await getWebDAVPassword(
      "https://dav.jianguoyun.com/other/",
      "person@example.test",
    )).toBe("app-password");
    expect(logins).toEqual([
      expect.objectContaining({
        origin: "https://dav.jianguoyun.com",
        httpRealm: "UniZero WebDAV",
        username: "person@example.test",
        password: "app-password",
      }),
    ]);
  });

  it("replaces and removes only the selected account credential", async () => {
    await saveWebDAVPassword(
      "https://dav.example.test/dav/",
      "one@example.test",
      "first",
    );
    await saveWebDAVPassword(
      "https://dav.example.test/dav/",
      "two@example.test",
      "second",
    );
    await saveWebDAVPassword(
      "https://dav.example.test/dav/",
      "one@example.test",
      "replacement",
    );

    expect(await getWebDAVPassword(
      "https://dav.example.test/dav/",
      "one@example.test",
    )).toBe("replacement");
    expect(await getWebDAVPassword(
      "https://dav.example.test/dav/",
      "two@example.test",
    )).toBe("second");
    await removeWebDAVPassword(
      "https://dav.example.test/dav/",
      "one@example.test",
    );
    expect(await getWebDAVPassword(
      "https://dav.example.test/dav/",
      "one@example.test",
    )).toBe("");
    expect(logins).toHaveLength(1);
  });

  it("refuses insecure credential origins", async () => {
    await expect(getWebDAVPassword(
      "http://dav.example.test/dav/",
      "person@example.test",
    )).rejects.toThrow("must use HTTPS");
  });
});
