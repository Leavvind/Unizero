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


// ---- Paper runtime（本地 Python 服务）----
// 从 ZoMiner 的 extensions.zominer.* 搬过一次的标记，见 src/runtime-client/settings.ts。
pref("extensions.zotero.__addonRef__.legacyRuntimePrefsMigrated", false);

// 留空则自动探测：按 PATH 逐个试，选第一个装了 mineru 的解释器。
pref("extensions.zotero.__addonRef__.runtime.pythonPath", "");
// 无默认值：runtime 尚未随插件分发，路径只能由用户指定。
pref("extensions.zotero.__addonRef__.runtime.serverScript", "");
pref("extensions.zotero.__addonRef__.runtime.port", 23300);
pref("extensions.zotero.__addonRef__.runtime.autoStart", true);
// 只影响插件自己启动的进程；用户手动跑的服务不受关闭 Zotero 影响。
pref("extensions.zotero.__addonRef__.runtime.autoStopOnQuit", true);

// 除链接式 MD 附件外，再往 Zotero storage 存一份只读副本（随 Zotero 同步）。
pref("extensions.zotero.__addonRef__.conversion.mdSnapshot", true);




