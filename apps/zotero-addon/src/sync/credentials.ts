/**
 * WebDAV secrets live in Firefox's Login Manager, the same encrypted credential
 * store Zotero uses for its own WebDAV password. Preferences contain only the
 * server URL, username, and scheduling choices.
 */

const LOGIN_REALM = "UniZero WebDAV";

interface StoredLogin {
  username: string;
  password: string;
  httpRealm?: string;
}

function credentialOrigin(baseURL: string): string {
  const url = new URL(String(baseURL || "").trim());
  if (url.protocol !== "https:") {
    throw new Error("WebDAV URL must use HTTPS");
  }
  return url.origin;
}

async function matchingLogins(
  baseURL: string,
  username: string,
): Promise<StoredLogin[]> {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) { return []; }
  const logins = await Services.logins.searchLoginsAsync({
    origin: credentialOrigin(baseURL),
    httpRealm: LOGIN_REALM,
  });
  return (Array.from(logins || []) as StoredLogin[]).filter(
    (login: StoredLogin) => login.username === normalizedUsername,
  );
}

export async function getWebDAVPassword(
  baseURL: string,
  username: string,
): Promise<string> {
  const [login] = await matchingLogins(baseURL, username);
  return login ? String(login.password || "") : "";
}

export async function saveWebDAVPassword(
  baseURL: string,
  username: string,
  password: string,
): Promise<void> {
  const normalizedUsername = String(username || "").trim();
  // Trimmed deliberately: an application password is normally copied out of a
  // web page, and surrounding whitespace is far more often a paste artefact
  // than part of the secret. Covered by tests/syncCredentials.test.ts.
  const normalizedPassword = String(password || "").trim();
  if (!normalizedUsername || !normalizedPassword) {
    throw new Error("A WebDAV username and application password are required");
  }
  await removeWebDAVPassword(baseURL, normalizedUsername);
  const LoginInfo = new Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    Components.interfaces.nsILoginInfo,
    "init",
  );
  const login = new LoginInfo(
    credentialOrigin(baseURL),
    null,
    LOGIN_REALM,
    normalizedUsername,
    normalizedPassword,
    "",
    "",
  );
  await Services.logins.addLoginAsync(login);
}

export async function removeWebDAVPassword(
  baseURL: string,
  username: string,
): Promise<void> {
  for (const login of await matchingLogins(baseURL, username)) {
    Services.logins.removeLogin(login);
  }
}
