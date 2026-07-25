pref("extensions.zotero.__addonRef__.enable", true);

// Marks the one-time migration of settings from the pre-UniZero addonRefs
// (zoference / zoteroreference); see src/modules/migrate.ts.
pref("extensions.zotero.__addonRef__.legacyPrefsMigrated", false);

pref("extensions.zotero.__addonRef__.autoRefresh", false);
pref("extensions.zotero.__addonRef__.notAutoRefreshItemTypes", "book, letter, note");
pref("extensions.zotero.__addonRef__.isShowTip", true);
pref("extensions.zotero.__addonRef__.ctrlClickTranslate", true);
pref("extensions.zotero.__addonRef__.showTipAfterMillisecond", 233);
pref("extensions.zotero.__addonRef__.shadeMillisecond", 233);
pref("extensions.zotero.__addonRef__.removeTipAfterMillisecond", 500);
pref("extensions.zotero.__addonRef__.tipBackgroundColor", "#ffffff");
pref("extensions.zotero.__addonRef__.tipTitleColor", "#2270d9");


pref("extensions.zotero.__addonRef__.loadingRelated", true);

pref("extensions.zotero.__addonRef__.clickLink", true);
pref("extensions.zotero.__addonRef__.clickLink.cmd", "splitHorizontally");
pref("extensions.zotero.__addonRef__.hoverLink", true);


pref("extensions.zotero.__addonRef__.arXivInfoIndex", 0);
pref("extensions.zotero.__addonRef__.DOIInfoIndex", 0);
pref("extensions.zotero.__addonRef__.TitleInfoIndex", 0);
// On by default: the references themselves never change, while re-fetching them
// costs hundreds of enrichment requests.
pref("extensions.zotero.__addonRef__.saveAPIReferences", true);
pref("extensions.zotero.__addonRef__.saveCitations", true);

pref("extensions.zotero.__addonRef__.notInLibarayOpacity", "1");

// Semantic Scholar API key. Anonymous calls are capped near 1 rps and often 429;
// a key raises the quota considerably.
pref("extensions.zotero.__addonRef__.semanticScholar.apiKey", "");


// ---- Paper runtime (local Python service) ----
// Marks the one-time migration from ZoMiner's extensions.zominer.*; see
// src/runtime-client/settings.ts.
pref("extensions.zotero.__addonRef__.legacyRuntimePrefsMigrated", false);

// Leave empty to auto-detect: try each interpreter on PATH and take the first one
// with mineru installed.
pref("extensions.zotero.__addonRef__.runtime.pythonPath", "");
// No default: the runtime is not shipped with the add-on yet, so only the user can
// supply this path.
pref("extensions.zotero.__addonRef__.runtime.serverScript", "");
pref("extensions.zotero.__addonRef__.runtime.port", 23300);
pref("extensions.zotero.__addonRef__.runtime.autoStart", true);
// Applies only to processes the add-on started itself; a service the user launched
// manually is unaffected by closing Zotero.
pref("extensions.zotero.__addonRef__.runtime.autoStopOnQuit", true);

// Alongside the linked MD attachment, keep a read-only copy in Zotero storage so it
// travels with Zotero sync.
pref("extensions.zotero.__addonRef__.conversion.mdSnapshot", true);

// Obsidian vault holding the converted Markdown. Set it to open a note by the
// stable `uid` in its frontmatter, which survives a rename inside the vault;
// left empty, notes open by absolute path, which does not.
pref("extensions.zotero.__addonRef__.conversion.obsidianVault", "");




