pref("extensions.zotero.__addonRef__.enable", true);

// 改名 UniZero 后从旧 addonRef（zoference / zoteroreference）搬过一次设置的标记，
// 见 src/modules/migrate.ts。
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
// 默认开：参考文献本身不变，而重取一次要跑上百个补全请求。
pref("extensions.zotero.__addonRef__.saveAPIReferences", true);
pref("extensions.zotero.__addonRef__.saveCitations", true);

pref("extensions.zotero.__addonRef__.notInLibarayOpacity", "1");

// Semantic Scholar API key。匿名调用限到 ~1rps 且常 429；填了 key 配额高得多。
pref("extensions.zotero.__addonRef__.semanticScholar.apiKey", "");




