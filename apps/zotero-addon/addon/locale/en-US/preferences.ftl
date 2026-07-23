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
  .label = Start the service automatically when needed
runtime-autoStopOnQuit =
  .label = Stop the service when Zotero quits (only one this add-on started)

caption-conversion = Conversion
conversion-mdSnapshot =
  .label = Store a Markdown copy on the item after conversion
conversion-note = The copy syncs with Zotero and is readable on other machines, at the cost of being overwritten on every re-conversion.
