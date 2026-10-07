caption-refresh = Refresh
autoRefresh =
  .label = Automatically refresh references when opening the reader, except for these item types
  



caption-tip = Tip
isShowTip-start = 
  .label = The floating window is displayed after the mouse stays on the reference for
isShowTip-end = ms

ctrlClickTranslate = 
  .label = Inside the floating window, hold down CTRL and click Text Translate

shadeMillisecond-start = Floating window display/disappearing transparency shades
shadeMillisecond-end = ms

removeTipAfterMillisecond-start = Finally disappears automatically after
removeTipAfterMillisecond-end = ms

tipBackgroundColor = Background Color
tipTitleColor = Title Color


caption-related = Related
loadingRelated = 
  .label = Related panel loads recommended related items



caption-link = Link
clickLink-start = 
  .label = Click link to jump in a split window
clickLink-splitHorizontally = 
  .label = Horizontally
clickLink-splitVertically = 
  .label = Vertically
clickLink-end = 
hoverLink = 
  .label = Hover link to display a floating window


caption-save = Save
saveAPIReferences = 
  .label = Save references from API (DOI route)
saveCitations = 
  .label = Save citations
save-note = Saved lists are reused instead of re-querying. Click Refresh in the section to fetch again.


caption-match = Match
notInLibarayOpacity-start = Match items and show items that are not in my library with transparency
notInLibarayOpacity-end =

caption-api = Data sources
sourceOrder-note = References are fetched by DOI first (OpenAlex → Crossref → Semantic Scholar). Items without a DOI fall back to references extracted during conversion.
semanticScholarApiKey = Semantic Scholar API key
semanticScholarApiKey-note = Optional. Without a key requests are limited to about 1 per second and often fail with 429.

caption-runtime = Local service
runtime-note = Converting PDFs needs the local Python runtime. Once unizero-runtime is installed, both paths can stay empty.
runtime-pythonPath = Python path
runtime-pythonPath-input =
  .placeholder = Empty = detect automatically
runtime-serverScript = server.py path
runtime-serverScript-input =
  .placeholder = Empty = find the installed unizero-runtime
runtime-port = Port
runtime-port-note = Takes effect the next time the service starts
runtime-autoStart =
  .label = Start the service in the background when Zotero starts
runtime-autoStopOnQuit =
  .label = Stop the service when Zotero quits (only the one this add-on started)

caption-conversion = Conversion
conversion-mdSnapshot =
  .label = Store a Markdown copy on the item after conversion
conversion-note = The copy syncs with Zotero and is readable on other machines, at the cost of being overwritten on every re-conversion.

conversion-obsidianVault = Obsidian vault
conversion-obsidianVault-input =
  .placeholder = Vault name
conversion-obsidianVault-note = Open in Obsidian then jumps by the note's uid, which survives renaming or moving it inside the vault. Requires the Advanced URI plugin. Left empty, notes open by file path instead.

caption-sync = WebDAV sync
sync-note = Currently syncs Projects, Boards, nodes, edges, and deletion tombstones. Designed for Jianguoyun WebDAV.
sync-webdav-url = WebDAV URL
sync-webdav-username = Account email
sync-webdav-password = Application password
sync-webdav-password-note = Generate a third-party application password in Jianguoyun. When remembered, it is stored in Zotero's secure password manager and never synced.
sync-remember-password =
  .label = Remember the application password securely on this device
sync-auto =
  .label = Sync automatically
sync-interval = Frequency
sync-interval-30 = Every 30 minutes
sync-interval-60 = Every hour
sync-interval-180 = Every 3 hours
sync-interval-360 = Every 6 hours
sync-notifications = Background notifications
sync-notifications-errors = Errors only
sync-notifications-all = All results
sync-notifications-none = None
sync-now = Sync now
sync-status-running = Syncing…
sync-status-continuing = Syncing… { $remaining } batches remaining
sync-status-done = Done: { $uploaded } uploaded, { $downloaded } downloaded, { $merged } merged, { $remaining } batches remaining
sync-status-deferred = { $skipped } documents need a newer UniZero version and were left on the server.
sync-status-error = Sync failed: { $message }
sync-status-password-save-error = Sync completed, but the application password could not be saved.
sync-status-last-success = Last synced: { $time }
sync-status-last-error = Last sync failed: { $message }
