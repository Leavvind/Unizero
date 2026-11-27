/**
 * Opens an `obsidian://` URL with the system's Obsidian handler.
 *
 * `Zotero.launchURL` routes custom schemes through Firefox's external-protocol
 * chooser, which asks "Open the obsidian link with Obsidian?" on every click and
 * offers no way to remember the answer for Zotero itself. Launching the scheme's
 * handler info directly with the system default skips that chooser. The handler
 * info is not stored, so Zotero's handler preferences are left untouched. If the
 * OS has no `obsidian` handler, or the direct launch fails, it falls back to
 * `Zotero.launchURL`, prompt included.
 */
export function launchObsidianURL(url: string): void {
  if (!url.startsWith("obsidian://")) {
    throw new Error("Only obsidian:// URLs can be opened this way");
  }
  try {
    const service = Components.classes["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Components.interfaces.nsIExternalProtocolService) as any;
    if (service.externalProtocolHandlerExists("obsidian")) {
      const handler = service.getProtocolHandlerInfo("obsidian");
      handler.preferredAction = Components.interfaces.nsIHandlerInfo.useSystemDefault;
      handler.alwaysAskBeforeHandling = false;
      handler.launchWithURI(Services.io.newURI(url));
      return;
    }
  } catch (error) {
    Zotero.debug(`[UniZero] direct obsidian:// launch failed, using Zotero.launchURL: ${error}`);
  }
  Zotero.launchURL(url);
}
