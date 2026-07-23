import { config, version } from "../../package.json";
import { initLocale, getString } from "../utils/locale";
import TipUI from "./tip";
import Utils from "./utils";
import LocalStorge from "./localStorage";
import { readZoMinerReferences, findReferencesAttachment } from "./zomReferences";
import { fetchReferencesByIdentifiers, referencesDiagnostics } from "./referencesApi";
import {
  fetchCitationsByIdentifiers,
  fetchCitationsPage,
  citationsDiagnostics,
} from "./citationsApi";
import { resolveMany } from "./resolve";
import { PanelStatus } from "./status";
import { readItemPaperIdentifiers } from "./itemIdentifiers";
const localStorage = new LocalStorge(config.addonRef);

/**
 * 缓存键。带版本号是因为缓存里存的是已解析完的结构化条目，字段一旦扩充，
 * 旧记录会以“看起来完整实则缺字段”的形式静默存活，比缓存未命中更难查。
 */
const CACHE_KEY_REFERENCES = "References-Resolved-v1";
const CACHE_KEY_CITATIONS = "Citations-v1";

interface ReferencesCache {
  savedAt: number;
  source: string;
  /** 存档时的标识符；任一变化都说明旧列表可能不再属于这篇论文。 */
  doi: string;
  semanticScholarPaperId?: string;
  /** 元数据补全是否已跑完。false 表示这是抢在补全前落的盘，读回来要接着补。 */
  resolved: boolean;
  references: ItemBaseInfo[];
}

interface CitationsCache {
  savedAt: number;
  doi: string;
  semanticScholarPaperId?: string;
  source: "OpenAlex" | "Semantic Scholar";
  openAlexFilter?: string;
  page: number;
  loaded: number;
  total: number;
  all: ItemBaseInfo[];
}

export default class Views {
  public utils!: Utils;
  private registeredPaneID?: string;
  private registeredCitationsPaneID?: string;
  /** 区块每次重建都是新 DOM，选中的标签页只能记在实例上才能跨重建保留。 */
  private lastActiveTab: "references" | "citations" = "references";
  /** 最近一次加载参考文献走的是哪条路，供 UniZeroDebug() 回读。 */
  private lastLoadDiagnostic: any = null;
  /** 同上，Citations 那一路。 */
  private lastCitationsDiagnostic: any = null;
  constructor() {
    initLocale();
    this.utils = new Utils()
    this.addStyle()
  }

  private addStyle() {
    const styles = ztoolkit.UI.createElement(document, "style", {
      id: "reference-style",
      namespace: "html",
      properties: {
        innerHTML: `
          .zoference-section {
            width: 100%;
            box-sizing: border-box;
            color: var(--fill-primary, inherit);
          }
          .zoference-section .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 4px 8px 8px;
          }
          .zoference-section .header button {
            min-height: 24px;
          }
          .zoference-section .reference-grid {
            display: grid;
            align-items: center;
            overflow-y: auto;
          }
          .zoference-section .reference-recommendations {
            margin-top: 12px;
            padding-top: 8px;
            border-top: 1px solid var(--material-border, #d8d8d8);
          }
          .zoference-section .recommendations-title {
            padding: 0 8px 6px;
            font-weight: 600;
          }
          .zoference-section .reference-tabs {
            display: flex;
            gap: 2px;
            padding: 2px 6px 6px;
            border-bottom: 1px solid var(--material-border, #d8d8d8);
            margin-bottom: 6px;
          }
          .zoference-section .reference-tab {
            flex: 1;
            min-height: 24px;
            background: transparent;
            border: none;
            border-radius: 4px;
            padding: 3px 8px;
            cursor: pointer;
            color: inherit;
            opacity: 0.65;
          }
          .zoference-section .reference-tab:hover {
            background: var(--fill-quinary, rgb(128 128 128 / 12%));
            opacity: 0.85;
          }
          .zoference-section .reference-tab.active {
            background: var(--fill-quarternary, rgb(128 128 128 / 20%));
            font-weight: 600;
            opacity: 1;
          }
          /* 不依赖 UA 样式表对 [hidden] 的处理：这个 section 挂在 Zotero 的 XHTML
             主窗口里，隐藏必须由我们自己的规则说了算，否则切页看着像没反应。 */
          .zoference-section .reference-tab-pane[hidden],
          .zoference-section .reference-tab-pane.is-hidden {
            display: none !important;
          }
          /* 面板内状态条：提示贴着触发操作的地方出现，不再飞到屏幕右下角。 */
          .zoference-section .reference-status {
            display: flex;
            align-items: center;
            gap: 6px;
            position: relative;
            margin: 0 6px 6px;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.9em;
            line-height: 1.4;
            background: var(--fill-quinary, rgb(128 128 128 / 12%));
            border-left: 3px solid var(--fill-tertiary, rgb(128 128 128 / 45%));
          }
          .zoference-section .reference-status[data-type="success"] {
            border-left-color: var(--accent-green, #57ab5a);
          }
          .zoference-section .reference-status[data-type="fail"] {
            border-left-color: var(--accent-red, #e5534b);
          }
          .zoference-section .reference-status-headline {
            flex: none;
            font-weight: 600;
            opacity: 0.75;
          }
          .zoference-section .reference-status-text {
            flex: 1;
            min-width: 0;
            /* 状态条是一行高的固定装置：长文案截断，绝不把列表往下顶。 */
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            opacity: 0.9;
          }
          .zoference-section .reference-status-progress {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 2px;
            border-radius: 0 0 4px 4px;
            overflow: hidden;
          }
          .zoference-section .reference-status-progress-bar {
            height: 100%;
            width: 0;
            background: var(--accent-blue, #4a8fe0);
            transition: width 0.2s ease;
          }
          .zoference-section .citations-more {
            display: block;
            width: calc(100% - 16px);
            margin: 8px;
            min-height: 24px;
          }
          .reference-search-box .icon {
            display: flex;
            justify-content: center;
            align-items: center;
            opacity: 0.8;
          }
          .reference-search-box .icon:hover {
            opacity: 1
          }
        `
      },
    });
    document.documentElement.appendChild(styles);
  }
  /**
   * 注册阅读侧边栏
   */
  public async onInit() {
    // 版本号打到日志里：这轮排查最费时间的就是分不清“功能有 bug”还是“装的还是旧包”。
    ztoolkit.log(`${config.addonName} ${version} registering item pane section`);
    (Zotero as any)[`${config.addonInstance}Version`] = version;
    // 排查用出口：缓存到底存没存、存了谁，靠界面看不出来，逐轮猜太慢。
    // 在“运行 JavaScript”里调 Zotero.UniZeroDebug() 就能一次看全。
    (Zotero as any)[`${config.addonInstance}Debug`] = () => ({
      version,
      referencesCacheEnabled: this.isCacheEnabled("saveAPIReferences"),
      citationsCacheEnabled: this.isCacheEnabled("saveCitations"),
      rawPrefs: {
        saveAPIReferences: Zotero.Prefs.get(`${config.addonRef}.saveAPIReferences`),
        saveCitations: Zotero.Prefs.get(`${config.addonRef}.saveCitations`),
        semanticScholarKey: Boolean(Zotero.Prefs.get(`${config.addonRef}.semanticScholar.apiKey`)),
      },
      cacheFile: localStorage.filename,
      cacheLoaded: localStorage.cache !== undefined,
      entries: Object.entries(localStorage.cache || {}).map(([itemKey, value]) => ({
        itemKey,
        keys: Object.keys(value as object),
        references: (value as any)?.[CACHE_KEY_REFERENCES]?.references?.length,
        resolved: (value as any)?.[CACHE_KEY_REFERENCES]?.resolved,
        citations: (value as any)?.[CACHE_KEY_CITATIONS]?.all?.length,
      })).filter((entry) => entry.keys.length),
      lastReferenceLoad: this.lastLoadDiagnostic,
      lastCitationsLoad: this.lastCitationsDiagnostic,
      citationsEngines: citationsDiagnostics,
      referencesEngines: referencesDiagnostics,
    });
    const itemPaneManager = (Zotero as any).ItemPaneManager;
    if (!itemPaneManager?.registerSection) {
      throw new Error("Zotero.ItemPaneManager.registerSection is unavailable");
    }

    this.registeredPaneID = itemPaneManager.registerSection({
      paneID: "Reference",
      pluginID: config.addonRef,
      bodyXHTML: `
        <linkset>
          <html:link rel="localization" href="${config.addonRef}-addon.ftl"></html:link>
        </linkset>`,
      header: {
        l10nID: `${config.addonRef}-itemPaneSection-header`,
        icon: `chrome://${config.addonRef}/content/icons/reference.svg`,
      },
      sidenav: {
        l10nID: `${config.addonRef}-itemPaneSection-sidenav`,
        icon: `chrome://${config.addonRef}/content/icons/reference-sidenav.svg`,
      },
      onItemChange: ({ item, tabType, setEnabled }: any) => {
        // The reader may not have been added to Zotero.Reader yet when this hook
        // runs. Hiding the section based on getReader() therefore makes it stay
        // invisible for the lifetime of the tab in Zotero 8/9.
        setEnabled(["library", "reader"].includes(tabType) && Boolean(item));
      },
      onRender: ({ body, item, tabType }: any) => {
        if (!["library", "reader"].includes(tabType)) {
          body.querySelectorAll(".zoference-section").forEach((element: Element) => element.remove());
          return;
        }
        if (tabType === "library") {
          // ZoMiner 参考文献存在附件里，不依赖 Reader，Library 也能完整渲染。
          this.renderReferenceSection(body, item, undefined, true);
          return;
        }
        const reader = this.getReaderForBody(body);
        const attachment = reader && Zotero.Items.get((reader as any).itemID || (reader as any)._itemID);
        const parentItem = attachment?.parentItem || (item?.isAttachment?.() ? item.parentItem : item);
        if (!parentItem) { return; }
        this.renderReferenceSection(body, parentItem, reader);
      },
      onAsyncRender: async ({ body, item, tabType, setSectionSummary }: any) => {
        if (!["library", "reader"].includes(tabType)) { return; }
        const panel = body.querySelector(".zoference-section") as HTMLDivElement;
        if (!panel) { return; }
        const reader = (panel as any)._referenceReader || this.getReaderForBody(body);
        const parentItem = (panel as any)._referenceItem || item;
        // 自动加载只作用于 Reference 标签页；Citations 等用户真的切过去才拉。
        const referencesPane = this.getPane(panel, "references");
        setSectionSummary("");
        try {
          // DOI 直连 / ZoMiner 附件在两种标签页下都能用，不依赖 Reader，所以先统一走
          // 自动加载；只有这两个源都没有时，才回落到需要 Reader 的 PDF 解析路径。
          await this.autoLoadReferences(referencesPane, parentItem);
          if (tabType === "reader" && reader && referencesPane.getAttribute("isAutoLoaded") !== "true") {
            await this.maybeAutoRefresh(referencesPane, parentItem, reader);
          }
          await this.loadingRelated(referencesPane, parentItem);
        } catch (error) {
          ztoolkit.log("Reference section async render failed", error);
        }
      },
    }) as string
  }

  public onDestroy() {
    if (this.registeredPaneID) {
      (Zotero as any).ItemPaneManager?.unregisterSection(this.registeredPaneID);
      this.registeredPaneID = undefined;
    }
  }

  // ---------------------------------------------------------------- 本地缓存
  // 参考文献与被引列表都不是每天在变的东西，而重新取一次的代价很不对称：DOI 直连本身
  // 只是一两个请求，真正贵的是后面逐条补全元数据那上百个模糊匹配请求。所以缓存存的是
  // **解析完成之后**的结果，命中即整块跳过网络。

  /**
   * 开关判据是“没被显式关掉”，而不是“取到了 true”。
   *
   * 插件 prefs.js 只写默认分支：换版本、改默认值、装包时机不对，都可能让 `get` 返回
   * undefined。那时按“未开启”处理，缓存会整块静默失效——而这正是最难查的一类症状：
   * 功能代码全对，只是从没被允许运行。
   */
  private isCacheEnabled(pref: "saveAPIReferences" | "saveCitations"): boolean {
    return Zotero.Prefs.get(`${config.addonRef}.${pref}`) !== false;
  }

  private readReferencesCache(item: Zotero.Item): ReferencesCache | undefined {
    if (!this.isCacheEnabled("saveAPIReferences")) { return; }
    const cached = localStorage.get(item, CACHE_KEY_REFERENCES) as ReferencesCache | undefined;
    if (!cached?.references?.length) { return; }
    const identifiers = readItemPaperIdentifiers(item);
    if ((cached.doi || "").toLowerCase() !== (identifiers.doi || "").toLowerCase() ||
        (cached.semanticScholarPaperId || "").toLowerCase() !==
          (identifiers.semanticScholarPaperId || "").toLowerCase()) {
      return;
    }
    return cached;
  }

  private saveReferencesCache(
    item: Zotero.Item,
    source: string,
    references: ItemBaseInfo[],
    resolved: boolean,
  ) {
    if (!this.isCacheEnabled("saveAPIReferences")) { return; }
    if (!references.length) { return; }
    const identifiers = readItemPaperIdentifiers(item);
    const payload: ReferencesCache = {
      savedAt: Date.now(),
      source,
      doi: identifiers.doi || "",
      semanticScholarPaperId: identifiers.semanticScholarPaperId,
      resolved,
      references,
    };
    localStorage.set(item, CACHE_KEY_REFERENCES, payload).catch(
      (error) => ztoolkit.log("save references cache failed", error),
    );
    if (this.lastLoadDiagnostic) {
      this.lastLoadDiagnostic.savedAt = new Date().toLocaleTimeString();
      this.lastLoadDiagnostic.savedResolved = resolved;
      this.lastLoadDiagnostic.savedCount = references.length;
    }
  }

  private saveCitationsCache(pane: HTMLDivElement) {
    if (!this.isCacheEnabled("saveCitations")) { return; }
    const item = (pane as any)._referenceItem as Zotero.Item;
    const state = (pane as any)._citationsState as CitationsCache | undefined;
    if (!item || !state?.all?.length) { return; }
    localStorage.set(item, CACHE_KEY_CITATIONS, { ...state, savedAt: Date.now() }).catch(
      (error) => ztoolkit.log("save citations cache failed", error),
    );
  }

  /** 用缓存把 Citations 页整个还原（含翻页进度）。命中返回 true。 */
  private restoreCitationsFromCache(pane: HTMLDivElement): boolean {
    if (!this.isCacheEnabled("saveCitations")) { return false; }
    const item = (pane as any)._referenceItem as Zotero.Item;
    if (!item) { return false; }
    const identifiers = readItemPaperIdentifiers(item);
    const cached = localStorage.get(item, CACHE_KEY_CITATIONS) as CitationsCache | undefined;
    // 任一标识符变了都要失效；否则修正 DOI / Paper ID 后还会继续显示旧论文的列表。
    if (!cached?.all?.length ||
        (cached.doi || "").toLowerCase() !== (identifiers.doi || "").toLowerCase() ||
        (cached.semanticScholarPaperId || "").toLowerCase() !==
          (identifiers.semanticScholarPaperId || "").toLowerCase()) {
      return false;
    }
    (pane as any)._citationsState = { ...cached };
    pane.setAttribute("source", cached.source);
    const list = pane.querySelector(".reference-main-list .reference-grid") as HTMLDivElement;
    list.querySelectorAll("*").forEach((element) => element.remove());
    this.appendCitationRows(pane, cached.all);
    this.updateCitationsLabel(pane);
    const moreButton = pane.querySelector("#citations-more-button") as HTMLElement;
    this.setHidden(moreButton, cached.loaded >= cached.total);
    return true;
  }

  /**
   * 拉取并渲染“引用本文的论文”。
   *
   * @param pane   Citations 那个标签页的容器（不是整个 section）——两个标签页里都有
   *               `#reference-num` 和 `.reference-grid`，作用域必须收窄到本页，
   *               否则会去改到 Reference 那边的计数和列表。
   * @param silent 自动渲染时不弹提示，只有手动点刷新才反馈——否则每次展开区块都弹一次。
   */
  public async refreshCitations(
    pane: HTMLDivElement,
    silent: boolean = false,
    useCache: boolean = true,
  ) {
    const item = (pane as any)._referenceItem as Zotero.Item;
    if (!item) { return; }
    // 手动点刷新时 useCache=false：那一下的意思就是“我要最新的”。
    if (useCache && this.restoreCitationsFromCache(pane)) { return; }
    const label = pane.querySelector("#reference-num") as HTMLSpanElement;
    const list = pane.querySelector(".reference-main-list .reference-grid") as HTMLDivElement;
    list.querySelectorAll("*").forEach((element) => element.remove());
    const moreButton = pane.querySelector("#citations-more-button") as HTMLElement;
    this.setHidden(moreButton, true);

    const identifiers = readItemPaperIdentifiers(item);
    const doi = identifiers.doi || "";
    const semanticScholarPaperId = identifiers.semanticScholarPaperId || "";
    this.lastCitationsDiagnostic = {
      at: new Date().toLocaleTimeString(),
      itemKey: item.key,
      doi,
      semanticScholarPaperId,
      useCache,
      cacheEnabled: this.isCacheEnabled("saveCitations"),
      stage: "start",
    };
    if (!doi && !semanticScholarPaperId) {
      label.innerText = getString("citationsbox-no-identifier-label");
      this.lastCitationsDiagnostic.stage = "no-identifier";
      return;
    }

    label.innerText = getString("citationsbox-loading-label");
    let result;
    try {
      result = await fetchCitationsByIdentifiers(doi, semanticScholarPaperId);
    } catch (error) {
      // 之前这里没有 catch：一旦抛异常，计数就永远停在“正在获取引用...”，
      // 看着像卡死，而真正的原因一个字都不会露出来。
      this.lastCitationsDiagnostic.stage = "threw";
      this.lastCitationsDiagnostic.error = String(error);
      label.innerText = `${getString("citationsbox-number-label")} — ${String(error).slice(0, 80)}`;
      ztoolkit.log("refreshCitations failed", error);
      return;
    }
    this.lastCitationsDiagnostic.stage = result ? "fetched" : "empty";
    this.lastCitationsDiagnostic.total = result?.total;
    this.lastCitationsDiagnostic.source = result?.source;
    this.lastCitationsDiagnostic.pageSize = result?.citations.length;
    const citationFailures = [
      ["OpenAlex", citationsDiagnostics.openAlex],
      ["Semantic Scholar", citationsDiagnostics.semanticScholar],
    ].filter(([, status]) => String(status || "").startsWith("error:"));
    label.title = `OpenAlex: ${citationsDiagnostics.openAlex}
Semantic Scholar (${citationsDiagnostics.semanticScholarLookup || "no identifier"}): ${citationsDiagnostics.semanticScholar}`;
    this.lastCitationsDiagnostic.engines = { ...citationsDiagnostics };
    if (!result) {
      label.innerText = `0 ${getString("citationsbox-number-label")}`;
      if (!silent) {
        new PanelStatus("Citations")
          .createLine({
            text: citationFailures.length
              ? `Citation lookup incomplete: ${citationFailures.map(([source]) => source).join(", ")} failed`
              : "No citations found",
            type: citationFailures.length ? "fail" : "default",
          })
          .show();
      }
      return;
    }

    // 翻页状态挂在 pane 上：后续 “加载更多” 要沿用第一页选定的引擎和 filter，
    // 换引擎会因为两家排序不同而导致条目重复或跳号。
    (pane as any)._citationsState = {
      doi,
      semanticScholarPaperId,
      source: result.source,
      openAlexFilter: result.openAlexFilter,
      page: 1,
      loaded: result.citations.length,
      total: result.total,
      all: [...result.citations],
    };
    pane.setAttribute("source", result.source);
    try {
      this.appendCitationRows(pane, result.citations);
      this.updateCitationsLabel(pane);
    } catch (error) {
      // 取到了但渲染不出来，和根本没取到是两码事，必须能区分开。
      this.lastCitationsDiagnostic.stage = "render-failed";
      this.lastCitationsDiagnostic.error = String(error);
      label.innerText = `${result.total} ${getString("citationsbox-number-label")} (render failed)`;
      ztoolkit.log("appendCitationRows failed", error);
      return;
    }
    this.lastCitationsDiagnostic.stage = "rendered";
    this.setHidden(moreButton, !result.hasMore);
    this.saveCitationsCache(pane);

    if (!silent) {
      new PanelStatus(`[${result.source}]`)
        .createLine({
          text: citationFailures.length
            ? `${result.total} citations; ${citationFailures.map(([source]) => source).join(", ")} failed`
            : `${result.total} citations`,
          type: citationFailures.length ? "fail" : "success",
        })
        .show();
    }
  }

  /** “加载更多”：按被引数降序继续往下翻，追加到现有列表末尾。 */
  private async loadMoreCitations(pane: HTMLDivElement) {
    const state = (pane as any)._citationsState;
    if (!state) { return; }
    const moreButton = pane.querySelector("#citations-more-button") as HTMLElement;
    moreButton.style.pointerEvents = "none";
    moreButton.style.opacity = "0.5";
    try {
      const result = await fetchCitationsPage(
        state.doi,
        state.page + 1,
        state.source,
        state.openAlexFilter,
        state.semanticScholarPaperId,
      );
      if (!result?.citations.length) {
        this.setHidden(moreButton, true);
        return;
      }
      state.page += 1;
      state.loaded += result.citations.length;
      state.all.push(...result.citations);
      this.appendCitationRows(pane, result.citations);
      this.updateCitationsLabel(pane);
      this.setHidden(moreButton, !result.hasMore);
      // 每翻一页就落盘：翻到第 5 页再重开区块，不该又回到第 1 页。
      this.saveCitationsCache(pane);
    } finally {
      moreButton.style.pointerEvents = "";
      moreButton.style.opacity = "";
    }
  }

  /**
   * 把一页引用渲染成行。
   *
   * addRow 取的是 `references[refIndex]`，所以必须把累计数组整个传进去、配上全局下标，
   * 不能只传本页——否则行内交互读到的会是别人的数据。
   */
  private appendCitationRows(pane: HTMLDivElement, page: ItemBaseInfo[]) {
    const state = (pane as any)._citationsState;
    const container = pane.querySelector(".reference-main-list") as HTMLDivElement;
    const offset = state.all.length - page.length;
    page.forEach((citation, index) => {
      const row = this.addRow(container, state.all, offset + index);
      if (row) {
        // @ts-ignore addRow 建行时就绑好了，这里显式再绑一次以防 addRow 走了去重分支。
        row.box.reference = citation;
      }
    });
  }

  /** 计数显示成 “已加载/总数”，让人知道当前只是最重要的前几页而不是全部。 */
  private updateCitationsLabel(pane: HTMLDivElement) {
    const state = (pane as any)._citationsState;
    const label = pane.querySelector("#reference-num") as HTMLSpanElement;
    const suffix = getString("citationsbox-number-label");
    label.innerText = state.loaded < state.total
      ? `${state.loaded}/${state.total} ${suffix}`
      : `${state.total} ${suffix}`;
  }

  /** Resolve the reader that owns this item-pane section, not whichever tab is
   * globally selected at the instant a lifecycle hook happens to run. */
  private getReaderForBody(body?: Element): _ZoteroTypes.ReaderInstance | undefined {
    const itemDetails = body?.closest("item-details") as any;
    const tabID = itemDetails?.tabID || itemDetails?.dataset?.tabId;
    if (tabID) {
      const reader = Zotero.Reader.getByTabID(tabID);
      if (reader) { return reader; }
    }
    return this.utils.getReader();
  }

  private renderReferenceSection(
    body: HTMLDivElement,
    item: Zotero.Item,
    reader?: _ZoteroTypes.ReaderInstance,
    showReaderControls: boolean = true,
  ) {
    // onRender 会被 Zotero 反复调用（滚动、面板尺寸变化、条目刷新都可能触发），而
    // onAsyncRender 不保证跟着一起再跑一次。无条件重建就会出现：列表刚加载好，一次
    // 多余的 onRender 把 DOM 清空重建，自动加载却不再触发——区块从此空着不动。
    // 这正是“在库视图里切走再切回来，Reference 消失且不加载”的成因。
    const existing = body.querySelector(".zoference-section") as HTMLDivElement | null;
    if (existing && (existing as any)._referenceItem?.id === item.id) {
      if (reader) { (existing as any)._referenceReader = reader; }
      for (const name of ["references", "citations"] as const) {
        const pane = this.getPane(existing, name);
        (pane as any)._referenceItem = item;
        if (reader) { (pane as any)._referenceReader = reader; }
      }
      // onAsyncRender 未必会再来一次，所以这里补一次自动加载。它自带 isAutoLoaded 闸门，
      // 已经加载过的不会重复请求。
      void this.autoLoadReferences(this.getPane(existing, "references"), item).catch(
        (error) => ztoolkit.log("auto load on re-render failed", error),
      );
      return;
    }
    body.querySelectorAll(".zoference-section").forEach((element) => element.remove());
    // Zotero 主窗口是 XHTML（XML）文档：createElement 会建出 XUL 元素，且 innerHTML
    // 走 XML 解析器。必须显式用 XHTML 命名空间建元素。
    const panel = body.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    panel.className = "zoference-section";
    (panel as any)._referenceItem = item;
    if (reader) {
      (panel as any)._referenceReader = reader;
    }
    // Reference 和 Citations 合成一个区块的两个标签页：侧栏图标只有一个入口，
    // 两份数据又总是围绕同一篇论文，分成两个 section 会让侧栏和滚动都变碎。
    panel.innerHTML = showReaderControls ? `
      <div class="reference-tab-pane" data-tab="references">
        <div class="reference-main-list">
          <div class="header">
            <span id="reference-num">0 ${getString("relatedbox-number-label")}</span>
            <div id="refresh-button" class="reference-button">${getString("relatedbox-refresh-label")}</div>
          </div>
          <div class="grid reference-grid"></div>
        </div>
        <div class="reference-recommendations" hidden="hidden">
          <div class="recommendations-title">${getString("relatedbox-recommended-label")}</div>
          <div class="grid reference-grid"></div>
        </div>
      </div>
      <div class="reference-tab-pane is-hidden" data-tab="citations" hidden="hidden">
        <div class="reference-main-list">
          <div class="header">
            <span id="reference-num">0 ${getString("citationsbox-number-label")}</span>
            <div id="citations-refresh-button" class="reference-button">${getString("relatedbox-refresh-label")}</div>
          </div>
          <div class="grid reference-grid"></div>
          <div id="citations-more-button" class="reference-button citations-more">${getString("citationsbox-more-label")}</div>
        </div>
      </div>` : `<div class="reference-empty-state"></div>`;
    body.append(panel);

    if (!showReaderControls) { return; }

    this.buildTabBar(panel);
    panel.querySelectorAll(".reference-button").forEach(
      (element) => this.styleAsButton(element as HTMLElement),
    );
    // “加载更多”初始不显示：div 没有 hidden 属性的默认样式可依赖，必须显式关掉。
    this.setHidden(panel.querySelector("#citations-more-button") as HTMLElement, true);
    const referencesPane = this.getPane(panel, "references");
    const citationsPane = this.getPane(panel, "citations");
    // 两个标签页各自持有条目上下文：refresh* 只认自己那一页，不去翻整个 section。
    for (const pane of [referencesPane, citationsPane]) {
      (pane as any)._referenceItem = item;
      if (reader) { (pane as any)._referenceReader = reader; }
    }

    // 切页用事件委托 + 捕获阶段的 mousedown：逐个按钮绑 click 时，只要 Zotero 的
    // item pane 在冒泡路径上吃掉了 click（或区块被重建导致监听器丢失），点上去就毫无反应。
    const tabs = panel.querySelector(".reference-tabs") as HTMLDivElement;
    tabs.addEventListener("mousedown", (event: Event) => {
      const button = (event.target as HTMLElement)?.closest(".reference-tab") as HTMLElement | null;
      if (!button) { return; }
      event.preventDefault();
      this.selectTab(panel, button.dataset.tab as "references" | "citations");
    }, true);
    this.selectTab(panel, this.lastActiveTab, true);

    const countLabel = referencesPane.querySelector("#reference-num") as HTMLSpanElement;
    countLabel.addEventListener("dblclick", () => {
      const text = [...referencesPane.querySelectorAll(".reference-main-list .box #reference-label")]
        .map((element) => element.textContent || "")
        .filter(Boolean)
        .join("\n");
      if (!text) { return; }
      this.utils.copyText(text, false);
      new PanelStatus("Reference")
        .createLine({ text: "Copy all references", type: "success" })
        .show();
    });

    let timer: number | undefined;
    const refreshButton = referencesPane.querySelector("#refresh-button") as HTMLElement;
    refreshButton.addEventListener("mousedown", (event: MouseEvent) => {
      timer = window.setTimeout(async () => {
        timer = undefined;
        await this.refreshReferences(referencesPane, false);
      }, 1000);
    });
    refreshButton.addEventListener("mouseup", async (event: MouseEvent) => {
      if (!timer) { return; }
      window.clearTimeout(timer);
      timer = undefined;
      // 点刷新就是要最新的：local=false 绕过缓存，重新走 DOI 直连并覆盖存档。
      await this.refreshReferences(referencesPane, false);
    });
    refreshButton.addEventListener("mouseleave", () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    });

    const citationsRefresh = citationsPane.querySelector("#citations-refresh-button") as HTMLElement;
    citationsRefresh.addEventListener("click", async () => {
      await this.refreshCitations(citationsPane, false, false);
    });
    const citationsMore = citationsPane.querySelector("#citations-more-button") as HTMLElement;
    citationsMore.addEventListener("click", async () => {
      await this.loadMoreCitations(citationsPane);
    });
  }

  /**
   * 隐藏/显示。
   *
   * 同时改属性和内联 display——这个 section 活在 Zotero 的 XHTML 主窗口里，
   * 单靠 `hidden` 属性会不会生效取决于宿主样式表，不能赌。
   */
  private setHidden(element: HTMLElement, hidden: boolean) {
    element.hidden = hidden;
    element.style.display = hidden ? "none" : "";
  }

  /**
   * 把 div 打扮成按钮。
   *
   * 区块里所有按钮都是 div：`<button>` 在 Zotero 9 的 item pane 里根本不显示——
   * 标签栏从 `<button>` 换成 `<div>` 之后立刻可见，就是这么试出来的。同一个原因让
   * Citations 的“刷新”和“加载更多”也一直是隐形的。
   */
  private styleAsButton(element: HTMLElement) {
    element.style.cssText = [
      "display: inline-block", "padding: 3px 10px", "border-radius: 4px",
      "cursor: pointer", "user-select: none", "text-align: center",
      "font-size: inherit", "color: inherit", "white-space: nowrap",
      "border: 1px solid rgb(128 128 128 / 40%)", "background: rgb(128 128 128 / 10%)",
    ].join(";");
    element.addEventListener("mouseenter", () => {
      element.style.background = "rgb(128 128 128 / 22%)";
    });
    element.addEventListener("mouseleave", () => {
      element.style.background = "rgb(128 128 128 / 10%)";
    });
  }

  /**
   * 建标签栏。
   *
   * 刻意不走 innerHTML、不用 `<button>`、不依赖注入的样式表——这三样各自都可能是标签栏
   * 显示不出来的原因（XML 片段解析、宿主对 button 的样式、样式表没落到 item pane），
   * 逐个排查要好几轮。这里全部换成 DOM API 建 div + 内联样式，把三种可能一次排除掉。
   */
  private buildTabBar(panel: HTMLDivElement) {
    const doc = panel.ownerDocument;
    const create = (tag: string) =>
      doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;

    const bar = create("div");
    bar.className = "reference-tabs";
    bar.style.cssText = [
      "display: flex", "gap: 2px", "padding: 2px 6px 6px",
      "margin-bottom: 6px", "border-bottom: 1px solid rgb(128 128 128 / 30%)",
    ].join(";");

    for (const name of ["references", "citations"] as const) {
      const tab = create("div");
      tab.className = "reference-tab";
      tab.dataset.tab = name;
      tab.textContent = getString(name === "references" ? "tab-references-label" : "tab-citations-label")
        // Fluent 查不到时至少显示个能认的词，而不是一段空白让人以为标签栏没渲染。
        || (name === "references" ? "References" : "Citations");
      tab.style.cssText = [
        "flex: 1", "text-align: center", "padding: 4px 8px",
        "min-height: 20px", "border-radius: 4px", "cursor: pointer",
        "user-select: none", "font-size: inherit", "color: inherit",
      ].join(";");
      bar.append(tab);
    }

    panel.prepend(bar);
    ztoolkit.log("reference tab bar built", bar.childElementCount);
  }

  /**
   * 切换标签页。
   *
   * 隐藏同时改 `hidden` 属性、`is-hidden` 类和内联 display 三处：这个 section 活在
   * Zotero 的 XHTML 主窗口里，单靠其中任何一处都可能被宿主样式表盖掉，看着就是“点了没反应”。
   * 选中项记在 `panel.dataset.activeTab` 上，区块重建后能恢复到用户上次看的那页。
   */
  private selectTab(
    panel: HTMLDivElement,
    name: "references" | "citations",
    restoring: boolean = false,
  ) {
    panel.dataset.activeTab = name;
    panel.querySelectorAll(".reference-tab").forEach((element) => {
      const tab = element as HTMLElement;
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      // 选中态也走内联：注入的样式表要是没落到 item pane，两个标签会长得一模一样。
      tab.style.background = active ? "rgb(128 128 128 / 22%)" : "transparent";
      tab.style.fontWeight = active ? "600" : "normal";
      tab.style.opacity = active ? "1" : "0.7";
    });
    panel.querySelectorAll(".reference-tab-pane").forEach((element) => {
      const pane = element as HTMLElement;
      const hidden = pane.dataset.tab !== name;
      pane.hidden = hidden;
      pane.classList.toggle("is-hidden", hidden);
      pane.style.display = hidden ? "none" : "";
    });
    this.lastActiveTab = name;
    if (name !== "citations") { return; }
    const citationsPane = this.getPane(panel, "citations");
    if ((citationsPane as any)._citationsState) { return; }
    // 区块重建后恢复到 Citations 页时只读缓存，不联网：恢复是被动发生的，
    // 用户并没有要求刷新，换个条目就自动打两个 API 属于白烧配额。
    if (restoring) {
      if (!this.restoreCitationsFromCache(citationsPane)) {
        const label = citationsPane.querySelector("#reference-num") as HTMLSpanElement;
        label.innerText = getString("citationsbox-idle-label");
      }
      return;
    }
    // 用户主动切过去才拉数据——多数时候只看参考文献，每次展开区块都顺手打两个 API 是浪费。
    void this.refreshCitations(citationsPane, true).catch(
      (error) => ztoolkit.log("citations lazy load failed", error),
    );
  }

  /** 取某个标签页的容器。找不到时退回 section 本身，让旧调用点不至于直接抛错。 */
  private getPane(panel: HTMLDivElement, name: "references" | "citations"): HTMLDivElement {
    return (panel.querySelector(`.reference-tab-pane[data-tab="${name}"]`) as HTMLDivElement) || panel;
  }

  /** Library 视图：条目若已被 ZoMiner 抽取过参考文献，则自动读取附件并渲染。 */
  /**
   * 展开区块时自动加载参考文献。
   *
   * 判据是“有没有可用的数据源”，而不是“有没有 ZoMiner 附件”——加了 DOI 直连之后，
   * 带 DOI 的条目根本不需要附件也能出结果，旧的附件判据会把它们全挡在门外。
   */
  private async autoLoadReferences(panel: HTMLDivElement, item: Zotero.Item) {
    if (!item) { return; }
    if (panel.getAttribute("isAutoLoaded") === "true") { return; }
    const hasSource = Boolean(item.getField("DOI")) || Boolean(findReferencesAttachment(item));
    if (!hasSource) { return; }
    panel.setAttribute("isAutoLoaded", "true");
    await this.refreshReferences(panel, true, true);
  }

  private async maybeAutoRefresh(
    panel: HTMLDivElement,
    item: Zotero.Item,
    reader: _ZoteroTypes.ReaderInstance,
  ) {
    if (!Zotero.Prefs.get(`${config.addonRef}.autoRefresh`)) { return; }
    if (panel.getAttribute("isAutoRefresh") === "true") { return; }
    const excludeItemTypes = String(
      Zotero.Prefs.get(`${config.addonRef}.notAutoRefreshItemTypes`) || "",
    ).split(/,\s*/);
    const itemType = item.itemType;
    if (!excludeItemTypes.includes(itemType)) {
      (panel as any)._referenceReader = reader;
      await this.refreshReferences(panel);
      panel.setAttribute("isAutoRefresh", "true");
    }
  }

  private async registerSplitButtons(reader: _ZoteroTypes.ReaderInstance) {
    let _window: any
    // @ts-ignore
    while (!(_window = reader?._iframeWindow?.wrappedJSObject)) {
      ztoolkit.log("wait...")
      await Zotero.Promise.delay(10)
    }
    const parent = _window.document.querySelector("#toolbarViewerLeft")!
    const ref = parent.querySelector("#pageNumber") as HTMLDivElement
    const styles = {
      backgroundSize: "16px 16px",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      width: "16px"
    }
    
    ztoolkit.UI.insertElementBefore({
      tag: "div",
      classList: ["splitToolbarButton"],
      children: [
        {
          tag: "button",
          namespace: "html",
          id: "split-horizontally",
          classList: ["toolbarButton"],
          styles: {
            backgroundImage: `url(chrome://${config.addonRef}/content/icons/horizontally.png)`,
            // backgroundImage: await Zotero.File.generateDataURI(
            //   `chrome://${config.addonRef}/content/icons/horizontally.png`, 'image/png'
            // ),
            marginRight: "1px",
            ...styles
          },
          attributes: {
            title: "Split Horizontally",
            tabindex: "-1",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                reader.menuCmd("splitHorizontally")
              }
            }
          ]
        },
        {
          tag: "button",
          namespace: "html",
          id: "split-vertically",
          classList: ["toolbarButton"],
          styles: {
            backgroundImage: `url(chrome://${config.addonRef}/content/icons/split.png)`,
            // backgroundImage: await Zotero.File.generateDataURI(
            //   `chrome://${config.addonRef}/content/icons/vertically.png`, 'image/png'
            // ),
            marginLeft: "0",
            ...styles
          },
          attributes: {
            title: "Split Vertically",
            tabindex: "-1",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                reader.menuCmd("splitVertically")
              }
            }
          ]
        }
      ]
    }, ref)

    // ztoolkit.UI.appendElement({
    //   tag: "style",
    //   id: "reference-style",
    //   properties: {
    //     innerHTML: `
    //       #split-horizontally.toolbarButton::before {
    //         background-image: url("chrome://${config.addonRef}/content/icons/horizontally.png");
    //       }
    //       #split-vertically.toolbarButton::before {
    //         background-image: url("chrome://${config.addonRef}/content/icons/vertically.png");
    //       }
    //     `
    //   },
    // }, ((_window.document as Document).documentElement));
  }

  /**
   * 刷新推荐相关
   * @param array 
   * @param node 
   * @returns 
   */
  public refreshRelated(array: ItemBaseInfo[], node: HTMLDivElement) {
    let totalNum = 0
    // @ts-ignore
    array.forEach((info: ItemBaseInfo, i: number) => {
      let {box, label} = this.addRow(node, array, i, false, false) as any
      if (!box) { return }
      box.classList.add("only-title")
      totalNum += 1;
      // let box = row.querySelector("box") as XUL.Box
    })
    return totalNum
  }

  /**
 * Only item with DOI is supported
 * @returns 
 */
  async loadingRelated(panel?: HTMLDivElement, currentItem?: Zotero.Item) {
    if (!Zotero.Prefs.get(`${config.addonRef}.loadingRelated`)) { return }
    ztoolkit.log("loadingRelated");
    let item = currentItem || this.utils.getItem() as Zotero.Item
    if (!item) { return }
    let itemDOI = item.getField("DOI") as string
    if (!itemDOI || !this.utils.isDOI(itemDOI)) {
      ztoolkit.log("Not DOI", itemDOI);
      return
    }
    ztoolkit.log("getDOIRelatedArray")
    let _relatedArray = (await this.utils.API.getDOIRelatedArray(itemDOI)) as ItemBaseInfo[] || []
    if (!panel) { return }
    const node = panel.querySelector(".reference-recommendations") as HTMLDivElement
    if (!node) { return }
    const grid = node.querySelector(".reference-grid") as HTMLDivElement
    grid.replaceChildren()
    const relatedArray = (item.relatedItems.map((key: string) => {
      try {
        return Zotero.Items.getByLibraryAndKey(item.libraryID, key) as Zotero.Item
      } catch { }
    })
      .filter(i => i) as Zotero.Item[])
      .map((relatedItem: Zotero.Item) => {
        return {
          identifiers: { DOI: relatedItem.getField("DOI") },
          authors: [],
          title: relatedItem.getField("title"),
          text: relatedItem.getField("title"),
          url: relatedItem.getField("url"),
          type: relatedItem.itemType,
          year: relatedItem.getField("year"),
          _item: relatedItem
        } as ItemBaseInfo
      }).concat(_relatedArray)
    node.hidden = relatedArray.length === 0
    if (relatedArray.length) {
      this.refreshRelated(relatedArray, node)
    }
  }

  public async pdfLinks(reader: _ZoteroTypes.ReaderInstance, panel: XUL.TabPanel) {
    let _pdfDocument: any, _window: any
    // @ts-ignore
    while (!((_window = reader?._iframeWindow?.wrappedJSObject) && (_pdfDocument = _window.PDFViewerApplication?.pdfDocument))) {
      await Zotero.Promise.delay(10)
    }
    // let refKeys: any = []
    const dests = await _pdfDocument._transport.getDestinations()
    // window.setTimeout(async () => {
    //   dests = await _pdfDocument._transport.getDestinations()
    //   // 分析href与参考文献对应
    //   // 统计与参考文献数量一致的引文
    //   const statistics: any = {}
    //   Object.keys(dests).forEach(key => {
    //     let _key = key.replace(/\d/g, "")
    //     statistics[_key] ??= 0
    //     statistics[_key] += 1
    //   })
    //   // const totalNum = 36
    //   // let refKey = Object.keys(statistics).find(k => statistics[k] == totalNum)
    //   // 用最大值概率最大，但是有一定风险
    //   let refKey = Object.keys(statistics).sort((k1, k2) => statistics[k2]- statistics[k1])[0]
    //   Object.keys(dests).forEach(key => {
    //     if (key.replace(/\d/g, "") == refKey) {
    //       refKeys.push(key)
    //     }
    //   })
    //   // 根据匹配数字排序
    //   refKeys = refKeys.sort((k1: string, k2: string) => {
    //     let n1 = Number(k1.match(/\d+/)![0])
    //     let n2 = Number(k2.match(/\d+/)![0])
    //     return n1 - n2
    //   })
    // })
    let id = window.setInterval(async () => {
      try {
        _window.document
      } catch (e) {
        ztoolkit.log(e)
        window.clearInterval(id)
        return await this.pdfLinks(reader, panel)
      }
      
      _window.document
        .querySelectorAll(`section.linkAnnotation a[href^='#']:not([${config.addonRef}])`).forEach(async (a: any) => {
          const isClickLink = Zotero.Prefs.get(`${config.addonRef}.clickLink`) as boolean
          const isHoverLink = Zotero.Prefs.get(`${config.addonRef}.hoverLink`) as boolean
          let _a: any, href = a.getAttribute("href")
          if (href.indexOf("fig") >=0) {return }
          if (isClickLink) {
            _a = ztoolkit.UI.appendElement({
              tag: "a",
              namespace: "html"
            }, a.parentNode) as HTMLDivElement
            _a.setAttribute(config.addonRef, href);
            _a.setAttribute("style", "cursor: pointer;")
            a.remove()
            _a.addEventListener("click", async (event: MouseEvent) => {
              event.stopPropagation();
              event.preventDefault();
              if (_window.secondViewIframeWindow == null) {
                await reader.menuCmd(
                  Zotero.Prefs.get(`${config.addonRef}.clickLink.cmd`) as any
                )
                while (
                  !(
                    _window?.secondViewIframeWindow?.PDFViewerApplication?.pdfDocument
                  )
                ) {
                  await Zotero.Promise.delay(100)
                }
                await Zotero.Promise.delay(1000)
              }
              // let dest = unescape()
              // 有报错，#39 
              _window.secondViewIframeWindow.eval(`PDFViewerApplication
                .pdfViewer.linkService.goToDestination("${href.slice(1) }")`)

            })
          }
          
          let timer: undefined | number
          _a = _a || a
          if (isHoverLink) {
            let tipUI: TipUI
            _a.addEventListener("mouseenter", async (event: MouseEvent) => {
              // @ts-ignore
              const references = panel.references
              if (!references) { return }
              const [x, y] = dests[href.slice(1)].slice(2, 4)
              // 确定 refIndex
              const distances = references.map((ref: { x: number; y: number }) => (x - ref.x) ** 2 + (y - ref.y) ** 2)
              const minDistance = [...distances].sort((a: number, b: number) => a-b)[0]
              const refIndex = distances.indexOf(minDistance)
              let reference = references[refIndex]
              if (reference) {
                timer = window.setTimeout(() => {
                  timer = undefined
                  let rect = _a.getBoundingClientRect()
                  rect.y = rect.y + 40;
                  tipUI = this.showTipUI(
                    rect,
                    reference,
                    "top center"
                  )
                }, 233)
              }
            })
            _a.addEventListener("mouseleave", async () => {
              window.clearTimeout(timer)
              if (tipUI) {
                const timeout = tipUI.removeTipAfterMillisecond
                tipUI.tipTimer = window.setTimeout(async () => {
                  tipUI && tipUI.container.remove()
                }, timeout)
              }
            })
          }
        })
    }, 100)
  }

  /**
   * 刷新按钮触发
   * @param local 是否允许从本地读取
   * @returns
   */
  public async refreshReferences(panel: HTMLDivElement, local: boolean = true, silent: boolean = false) {
    Zotero.ProgressWindowSet.closeAll();
    let label = panel.querySelector("#reference-num") as HTMLSpanElement;
    label.innerText = `${0} ${getString("relatedbox-number-label")}`;
    // clear
    panel.querySelectorAll(".reference-main-list .reference-grid > *").forEach(e => e.remove());
    panel.querySelectorAll("#zoference-search").forEach(e => e.remove());

    let references: ItemBaseInfo[] | undefined
    let item = (panel as any)._referenceItem || this.utils.getItem() as Zotero.Item
    if (!item) {
      throw new Error("Reference panel has no item context");
    }

    // 最优先：本地缓存。参考文献列表定下来就不再变，而重跑一次的代价并不在 DOI 直连本身，
    // 在于后面逐条补全元数据的上百个请求。local=false（手动刷新）才绕过。
    let fromCache = false
    const cached = local ? this.readReferencesCache(item) : undefined
    this.lastLoadDiagnostic = {
      at: new Date().toLocaleTimeString(),
      itemKey: item.key,
      itemTitle: String(item.getField("title") || "").slice(0, 60),
      // 库视图和阅读器走的是同一个 refreshReferences，但两边行为不一致，
      // 所以把上下文一起记下来——差异只可能出在这几个入参上。
      context: (panel as any)._referenceReader ? "reader" : "library",
      local, silent,
      cacheEnabled: this.isCacheEnabled("saveAPIReferences"),
      cacheHit: Boolean(cached),
      cachedResolved: cached?.resolved,
      cachedCount: cached?.references?.length,
    }
    if (cached) {
      references = cached.references
      fromCache = true
      panel.setAttribute("source", cached.source)
      label.title = `${cached.source} · ${new Date(cached.savedAt).toLocaleString()}`
      if (!silent) {
        (new PanelStatus(`[Saved] ${cached.source}`))
          .createLine({ text: `${cached.references.length} references`, type: "success" })
          .show()
      }
    }

    // DOI 可查 OpenAlex/Crossref/S2；没有 DOI 时，刚补全的 S2 Paper ID 仍可直接查
    // Semantic Scholar。两者都在时 Paper ID 是 S2 的精确入口，避免 DOI 映射到另一个版本。
    const identifiers = readItemPaperIdentifiers(item)
    const itemDOI = identifiers.doi || ""
    const semanticScholarPaperId = identifiers.semanticScholarPaperId || ""
    this.lastLoadDiagnostic.doi = itemDOI
    this.lastLoadDiagnostic.semanticScholarPaperId = semanticScholarPaperId
    if (!references && (itemDOI || semanticScholarPaperId)) {
      const popupWin = silent ? null : new PanelStatus("[Pending] API", { closeTime: -1 })
      const lookupLabel = itemDOI && semanticScholarPaperId
        ? "DOI + Semantic Scholar Paper ID"
        : itemDOI ? "DOI" : "Semantic Scholar Paper ID"
      popupWin?.createLine({ text: `Request references by ${lookupLabel}...`, type: "default" }).show()
      const result = await fetchReferencesByIdentifiers(itemDOI, semanticScholarPaperId)
      // 三家各自返回了多少，悬停在计数上就能看到——条数偏少时才分得清是
      // “这篇本来就引得少” 还是 “覆盖最全的那家挂了”。
      this.lastLoadDiagnostic.engines = { ...referencesDiagnostics }
      label.title = [
        `OpenAlex: ${referencesDiagnostics.openAlex}`,
        `Crossref: ${referencesDiagnostics.crossref}`,
        `Semantic Scholar (${referencesDiagnostics.semanticScholarLookup || "no identifier"}): ` +
          `${referencesDiagnostics.semanticScholar}`,
      ].join("\n")
      const referenceFailures = [
        ["OpenAlex", referencesDiagnostics.openAlex],
        ["Crossref", referencesDiagnostics.crossref],
        ["Semantic Scholar", referencesDiagnostics.semanticScholar],
      ].filter(([, status]) => String(status || "").startsWith("error:"))
      if (result) {
        references = result.references
        panel.setAttribute("source", result.source)
        popupWin?.changeHeadline(`[${result.source}]`)
        popupWin?.changeLine({
          text: referenceFailures.length
            ? `${result.references.length} references; ` +
              `${referenceFailures.map(([source]) => source).join(", ")} failed`
            : `${result.references.length} references`,
          type: referenceFailures.length ? "fail" : "success",
        })
      } else {
        popupWin?.changeHeadline("[API]")
        popupWin?.changeLine({
          text: referenceFailures.length
            ? `Reference lookup incomplete: ` +
              `${referenceFailures.map(([source]) => source).join(", ")} failed`
            : "No references found for these identifiers",
          type: referenceFailures.length ? "fail" : "default",
        })
      }
      popupWin?.startCloseTimer(3000)
    }

    // 回退数据源：ZoMiner 抽取的参考文献（JSON 附件）。纯抽取工件 → 本地解析补全标题/作者。
    const zomRefs = references ? null : await readZoMinerReferences(item)
    if (zomRefs) {
      references = zomRefs.map((ref) => {
        // ZoMiner 只给 raw 引文；标题/作者/年份先用本地解析补全（后续再由
        // Crossref/OpenAlex 覆盖）。注意 ref 自带空的 title/authors 占位，
        // 不能让它覆盖掉刚解析出来的结果。
        const parsed = this.utils.refText2Info(ref.text!)
        return {
          ...parsed,
          ...ref,
          title: ref.title || parsed.title,
          authors: ref.authors?.length ? ref.authors : parsed.authors,
          year: ref.year || parsed.year,
          identifiers: { ...this.utils.getIdentifiers(ref.text!), ...ref.identifiers },
        }
      })
      panel.setAttribute("source", "ZoMiner");
      // 自动加载（每次展开区块都会触发）不弹提示，否则点一次弹一次很吵；
      // 只有手动点刷新才反馈。
      if (!silent) {
        (new PanelStatus("[ZoMiner]"))
          .createLine({ text: `${references.length} references`, type: "success" })
          .show()
      }
    }

    const finalReferences: ItemBaseInfo[] = references || []
    const referenceNum = finalReferences.length
    // @ts-ignore
    panel.references = finalReferences
    finalReferences.forEach(async (reference: ItemBaseInfo, refIndex: number) => {
      let { box } = this.addRow(
        panel.querySelector(".reference-main-list") as HTMLDivElement,
        finalReferences,
        refIndex,
      )!;
      // @ts-ignore
      box.reference = reference
      label.innerText = `${refIndex + 1}/${referenceNum} ${getString("relatedbox-number-label")}`;
    })

    label.innerText = `${referenceNum} ${getString("relatedbox-number-label")}`;

    const source = panel.getAttribute("source") || "API";
    // 先落一份未补全的盘。补全一批上百条要跑几十秒，而在库视图里点着条目一个个看是常态——
    // 只在补全完成后才写缓存，等于最常见的路径下永远写不上，看着就是“缓存没生效”。
    if (!fromCache) {
      this.saveReferencesCache(item, source, finalReferences, false);
    }
    // 缓存里已经是补全过的就到此为止；半成品缓存要接着把剩下的补完再覆盖。
    if (fromCache && cached?.resolved) { return; }
    // 不 await：阻塞会让区块一直空着；解析完一条就地更新一条。
    this.resolveReferences(panel, finalReferences)
      // 只有整批都真的问到了 API 才标 resolved。有条目因为限流/断网没查成时保持
      // 半成品状态，下次展开还会把剩下的补完——否则一次 429 就被永久固化。
      .then((complete) => this.saveReferencesCache(item, source, finalReferences, complete))
      .catch((error) => ztoolkit.log("resolve references failed", error));
  }

  /**
   * 用 Crossref/OpenAlex 把 raw 引文补成结构化元数据（DOI/标题/作者/期刊/年份/摘要/被引数）。
   *
   * 直接原地改写 reference 对象：addRow 里的 `box.reference` 与这里指向同一个对象，
   * 而悬浮窗和 “+” 导入都是在交互发生时才去读它，所以补完即生效，不用重建行。
   * 这也是 “+” 能用起来的关键——它以 identifiers.DOI 为前提，而 raw 引文里通常没有 DOI。
   */
  private async resolveReferences(panel: HTMLDivElement, references: ItemBaseInfo[]): Promise<boolean> {
    const pending = references
      .map((reference, index) => ({ reference, index }))
      // 判据是“有没有标题”，不是“有没有 DOI”：
      //   - 已有标题的（OpenAlex/S2 直连回来的）本来就是结构化的，再跑一轮模糊匹配
      //     纯属浪费请求，还可能把对的覆盖成错的；
      //   - Crossref 的 reference 里有不少是“只有 DOI 没有任何文字”的条目，那种必须
      //     解析，否则列表里就是一行空白。resolveOne 见到 DOI 会走权威查询而非模糊匹配。
      .filter(({ reference }) => !reference.title && (reference.text || reference.identifiers?.DOI));
    if (!pending.length) { return true; }
    const label = panel.querySelector("#reference-num") as HTMLSpanElement | null;
    const total = references.length;
    const suffix = getString("relatedbox-number-label");
    let done = 0;

    const { failed } = await resolveMany(
      pending.map(({ reference }) => ({
        raw: reference.text || "",
        identifiers: reference.identifiers,
      })),
      (position, info) => {
        done += 1;
        const { reference } = pending[position];
        if (info) {
          // 低置信结果是“猜的”，只允许参与展示。写 identifiers 就等于把它送进 “+”
          // 的导入路径，而那条路会直接按 DOI 建条目——猜错就是导进一篇错的论文。
          // 标题同理不能落库：没有 DOI 时导入会拿标题反查 DOI，一样会导错。
          if (info.lowConfidence) {
            reference.lowConfidence = true;
            reference.abstract = info.abstract || reference.abstract;
            reference.source = info.source || reference.source;
            if (!label) { return; }
            label.innerText = done < pending.length
              ? `${total} ${suffix} · ${done}/${pending.length}`
              : `${total} ${suffix}`;
            return;
          }
          if (info.identifiers.DOI) {
            reference.identifiers = { ...reference.identifiers, DOI: info.identifiers.DOI };
          }
          reference.title = info.title || reference.title;
          reference.authors = info.authors?.length ? info.authors : reference.authors;
          reference.year = info.year || reference.year;
          reference.primaryVenue = info.primaryVenue || reference.primaryVenue;
          reference.abstract = info.abstract || reference.abstract;
          reference.citations = info.citations ?? reference.citations;
          reference.url = info.url || reference.url;
          reference.source = info.source || reference.source;
          // Crossref 常给出“只有 DOI 没有任何文字”的引用条目，建行时只能先摆一个
          // 占位串。解析出真正的书目信息后要把那一行就地换掉，否则列表里永远是 DOI。
          if (reference._placeholderText && info.title) {
            reference.text = [
              reference.authors?.length ? reference.authors.slice(0, 3).join(", ") : undefined,
              reference.year,
              reference.title,
              reference.primaryVenue,
            ].filter(Boolean).join(". ");
            delete reference._placeholderText;
            this.updateRowLabel(panel, reference);
          }
        }
        if (!label) { return; }
        label.innerText = done < pending.length
          ? `${total} ${suffix} · ${done}/${pending.length}`
          : `${total} ${suffix}`;
      },
    );
    return failed === 0;
  }

  /** 把某条 reference 对应的那一行文字换成最新的 text（行与对象通过 box.reference 关联）。 */
  private updateRowLabel(panel: HTMLDivElement, reference: ItemBaseInfo) {
    const boxes = [...panel.querySelectorAll(".reference-main-list .box")] as any[];
    const box = boxes.find((node) => node.reference === reference);
    const label = box?.querySelector("#reference-label") as HTMLLabelElement | undefined;
    if (label) {
      label.innerText = `[${reference.number ?? ""}] ${reference.text}`.replace(/^\[\]\s*/, "");
    }
  }

  public showTipUI(refRect: Rect, reference: ItemInfo, position: string, idText?: string) {
    let toTimeInfo = (t: string) => {
      if (!t) { return undefined }
      let info = (new Date(t)).toString().split(" ")
      return `${info[1]} ${info[3]}`
    }
    let tipUI = new TipUI()
    tipUI.onInit(refRect, position)
    const refText = reference.text!;
    let getDefalutInfoByReference = async () => {
      const localItem = reference._item
      let info: ItemInfo
      if (localItem) {
        info = {
          identifiers: {},
          authors: localItem.getCreators().map((i: any) => i.firstName + " " + i.lastName),
          tags: localItem.getTags().map((i: any) => {
            let ctag: any = localItem.getColoredTags().find((ci: any) => ci.tag == i.tag)
            if (ctag) {
              return {text: i.tag, color: ctag.color}
            } else {
              return i.tag
            }
          }),
          abstract: localItem.getField("abstractNote") as string,
          title: localItem.getField("title") as string,
          year: localItem.getField("year") as string,
          primaryVenue: localItem.getField("publicationTitle") as string,
          type: "",
          source: reference.source || undefined
        }
      } else {
        info = {
          identifiers: reference.identifiers || {},
          authors: reference.authors || [],
          type: "",
          year: reference.year || undefined,
          title: reference.title || idText || "Reference",
          tags: reference.tags || [],
          text: reference.text || refText,
          abstract: reference.abstract || refText,
          primaryVenue: reference.primaryVenue || undefined
          
        }
        let url = this.utils.identifiers2URL(info.identifiers)
        if (url) {
          info.url = url
        }
      }
      return info
    }
    let coroutines: Promise<ItemInfo | undefined>[], prefIndex: number, according: string
    if (reference?.identifiers.arXiv) {
      according = "arXiv"
      coroutines = [
        getDefalutInfoByReference(),
        this.utils.API.getArXivInfo(reference.identifiers.arXiv)
      ]
      prefIndex = parseInt(Zotero.Prefs.get(`${config.addonRef}.${according}InfoIndex`) as string)
    } else if (reference?.identifiers.DOI) {
      according = "DOI"
      coroutines = [
        getDefalutInfoByReference(),
        this.utils.API.getDOIInfoBySemanticscholar(reference.identifiers.DOI),
        this.utils.API.getTitleInfoByReadpaper(refText, {}, reference.identifiers.DOI),
        this.utils.API.getTitleInfoByConnectedpapers(reference.identifiers.DOI),
        this.utils.API.getDOIInfoByCrossref(reference.identifiers.DOI)
      ]
      prefIndex = parseInt(Zotero.Prefs.get(`${config.addonRef}.${according}InfoIndex`) as string)
    } else {
      according = "Title"
      coroutines = [
        getDefalutInfoByReference(),
        this.utils.API.getTitleInfoByReadpaper(reference.title),
        this.utils.API.getTitleInfoByCrossref(reference.title),
        this.utils.API.getTitleInfoByConnectedpapers(reference.title)
      ]
      prefIndex = parseInt(Zotero.Prefs.get(`${config.addonRef}.${according}InfoIndex`) as string)
    }
    const sourceConfig = {
      arXiv: { color: "#b31b1b", tip: "arXiv is a free distribution service and an open-access archive for 2,186,475 scholarly articles in the fields of physics, mathematics, computer science, quantitative biology, quantitative finance, statistics, electrical engineering and systems science, and economics. Materials on this site are not peer-reviewed by arXiv." },
      readpaper: { color: "#1f71e0", tip: "论文阅读平台ReadPaper共收录近2亿篇论文、2.7亿位作者、近3万所高校及研究机构，几乎涵盖了全人类所有学科。科研工作离不开论文的帮助，如何读懂论文，读好论文，这本身就是一个很大的命题，我们的使命是：“让天下没有难读的论文”" },
      semanticscholar: { color: "#1857b6", tip: "Semantic Scholar is an artificial intelligence–powered research tool for scientific literature developed at the Allen Institute for AI and publicly released in November 2015. It uses advances in natural language processing to provide summaries for scholarly papers. The Semantic Scholar team is actively researching the use of artificial-intelligence in natural language processing, machine learning, Human-Computer interaction, and information retrieval." },
      crossref: { color: "#89bf04", tip: "Crossref is a nonprofit association of approximately 2,000 voting member publishers who represent 4,300 societies and publishers, including both commercial and nonprofit organizations. Crossref includes publishers with varied business models, including those with both open access and subscription policies." },
      connectedpapers: { color: "#35999a", tip: "Connected Papers is a visual tool to help researchers and applied scientists find academic papers relevant to their field of work."},
      DOI: { color: "#fcb426" },
      Zotero: { color: "#d63b3b", tip: "Zotero is a free, easy-to-use tool to help you collect, organize, cite, and share your research sources." }
    }
    for (let i = 0; i < coroutines.length; i++) {
      // 不阻塞
      window.setTimeout(async () => {
        let info = await coroutines[i]
        if (!info) { return }
        const tagDefaultColor = "#59C1BD"
        let tags = info.tags!.map((tag: object | string) => {
          if (typeof tag == "object") {
            return { color: tagDefaultColor, ...(tag as object) }
          } else {
            return { color: tagDefaultColor, text: tag }
          }
        }) as any || []
        // 展示当前数据源tag
        if (info.source) { tags.push({ text: info.source, ...sourceConfig[info.source as keyof typeof sourceConfig], source: info.source }) }
        // 展示可点击跳转链接tag
        if (info.identifiers.DOI) {
          let DOI = info.identifiers.DOI
          tags.push({ text: "DOI", color: sourceConfig.DOI.color, tip: DOI, url: info.url })
        }
        if (info.identifiers.arXiv) {
          let arXiv = info.identifiers.arXiv
          tags.push({ text: "arXiv", color: sourceConfig.arXiv.color, tip: arXiv, url: info.url })
        }
        if (reference._item) {
          // 用本地Item更新数据
          tags.push({ text: "Zotero", color: sourceConfig.Zotero.color, tip: sourceConfig.Zotero.tip, item: reference._item })
        }
        // 添加
        tipUI.addTip(
          this.utils.Html2Text(info.title!)!,
          tags,
          [
            info.authors?.slice(0, 3).join(" / "),
            [info?.primaryVenue, toTimeInfo(info.publishDate as string) || info.year]
              .filter(e => e).join(" \u00b7 "),
            reference.description
          ].filter(s => s && s != ""),
          this.utils.Html2Text(info.abstract!)!,
          according,
          i,
          prefIndex,
          // 标题即链接：DOI 优先（能落到出版商正式页），退而求其次用数据源自带的 url。
          info.identifiers.DOI
            ? `https://doi.org/${info.identifiers.DOI}`
            : (info.url || this.utils.identifiers2URL(info.identifiers) || undefined)
        )
      })
    }
    return tipUI
  }

  public addRow(node: HTMLDivElement, references: ItemBaseInfo[], refIndex: number, addPrefix: boolean = true, addSearch: boolean = true) {
    let notInLibarayOpacity: string|number = Zotero.Prefs.get(`${config.addonRef}.notInLibarayOpacity`) as string
    if (/[\d\.]+/.test(notInLibarayOpacity)) {
      notInLibarayOpacity = Number(notInLibarayOpacity);
    } else {
      notInLibarayOpacity = 1
    }
    let reference = references[refIndex]
    // 非阻塞搜索
    let refText: string
    if (addPrefix) {
      refText = `[${reference?.number || (refIndex + 1)}] ${reference.text}`
    } else {
      refText = reference.text!
    }
    // 避免重复添加
    let toText = (s: string) => s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "") 
    if (
      [...node.querySelectorAll(".box label")].find((e: any) => toText(e.innerText) == toText(refText))
    ) {
      return
    }
    // id描述
    let idText = (
      reference.identifiers
      && Object.values(reference.identifiers).length > 0
      && Object.keys(reference.identifiers)[0] + ": " + Object.values(reference.identifiers)[0]
    ) || "Reference"
    // 当前item
    const contextPanel = node.closest(".zoference-section") as any
    let item = contextPanel?._referenceItem || this.utils.getItem()!
    let editTimer: number | undefined
    const box = ztoolkit.UI.createElement(
      document,
      "div",
      {
        namespace: "html",
        classList: ["box", "zotero-clicky"],
        listeners: [
          {
            type: "click",
            listener: (event: any) => {
              event.preventDefault()
              event.stopPropagation()
            }
          },
          {
            type: "mouseup",
            listener: async (event: any) => {
              event.preventDefault()
              event.stopPropagation()
              // ctrl点击跳转本地item/url
              if (event.ctrlKey || event.metaKey) {
                window.clearTimeout(editTimer)
                if (reference._item) {
                  return this.utils.selectItemInLibrary(reference._item)
                } else {
                  let item = await this.utils.searchLibraryItem(reference)
                  if (item) {
                    return this.utils.selectItemInLibrary(item)
                  }
                }
                let URL = reference.url
                if (!URL) {
                  const refText = reference.text!
                  let info: ItemBaseInfo = this.utils.refText2Info(refText);
                  const popupWin = (new PanelStatus("Searching URL", { closeTime: -1 }))
                    .createLine({ text: `Title: ${reference.title}`, type: "default" })
                    .show()
                  let DOI = (await this.utils.API.getTitleInfoByConnectedpapers(reference.title as string))?.identifiers.DOI
                  URL = this.utils.identifiers2URL({ DOI })
                  popupWin.close()
                }
                if (URL) {
                  (new PanelStatus("Launching URL", { closeOtherProgressWindows: true }))
                    .createLine({ text: URL, type: "default" })
                    .show()
                  Zotero.launchURL(URL);
                }
              } else {
                if (rows.querySelector("#reference-edit")) { return }
                if (editTimer) {
                  window.clearTimeout(editTimer)
                  Zotero.ProgressWindowSet.closeAll()
                  this.utils.copyText((idText ? idText + "\n" : "") + refText, false);
                  (new PanelStatus("Reference"))
                    .createLine({ text: refText, type: "success" })
                    .show()
                }
              }
            }
          },
        ],
        styles: {
          alignItems: "center",
          opacity: String(notInLibarayOpacity),
          paddingTop: "1px",
          paddingBottom: "1px"
        },
        children: [
          {
            tag: "img",
            attributes: {
              src: Zotero.ItemTypes.getImageSrc(reference.type as any) as string
            }
          },
          {
            tag: "label",
            id: "reference-label",
            properties: {
              innerText: refText
            },
            styles: {
              width: "100%"
            },
            listeners: [
              {
                type: "mousedown",
                listener: () => {
                  editTimer = window.setTimeout(() => {
                    editTimer = undefined
                    enterEdit()
                  }, 500);
                }
              }
            ]
          }
        ]
      }
    ) as XUL.Element
    const label = ztoolkit.UI.createElement(
      document, 
      "label",
      {
        id: "add-remove",
        namespace: "xul",
        attributes: {
          value: "+"
        },
        classList: [
          "zotero-clicky",
          "zotero-clicky-plus"
        ]
      }
    )

    let enterEdit = () => {
      let label = box.querySelector("#reference-label")! as XUL.Label
      label.style.display = "none"
      let textarea = ztoolkit.UI.createElement(
        document,
        "textarea",
        {
          id: "reference-edit",
          namespace: "html",
          attributes: {
            flex: "1",
            multiline: "true",
            rows: "4"
          },
          properties: {
            value: addPrefix ? label.innerText.replace(/^\[\d+\]\s+/, "") : label.innerText,
          },
          styles: {
            width: "100%"
          },
          listeners: [
            {
              type: "blur",
              listener: async () => {
                await exitEdit()
              }
            }
          ]
        }
      ) as HTMLTextAreaElement
      textarea.focus()
      label.parentNode!.insertBefore(textarea, label)
      let exitEdit = async () => {
        // 界面恢复
        let inputText = textarea.value
        if (!inputText) { return }
        label.style.display = ""
        // textbox.style.display = "none"
        textarea.remove()
        // 保存结果
        if (inputText == reference.text) { return }
        label.innerText = `[${refIndex + 1}] ${inputText}`;
        references[refIndex] = {
          ...reference,
          ...{ identifiers: this.utils.getIdentifiers(inputText) },
          ...this.utils.refText2Info(inputText),
          ...{ text: inputText }
        }
        reference = references[refIndex]
        let i = this.utils.searchLibraryItem(reference)
        const key = `References-${node.getAttribute("source")}`
        window.setTimeout(async () => {
          await localStorage.set(item, key, references)
        })
      }

      let id = window.setInterval(async () => {
        let active = rows.querySelector(".active")
        if (active && active != box) {
          await exitEdit()
          window.clearInterval(id)
        }
      }, 100)
    }

    let setState = (state: string = "") => {
      switch (state) {
        case "+":
          label.setAttribute("class", "zotero-clicky zotero-clicky-plus");
          label.setAttribute("value", "+");
          label.style.opacity = "1";
          break;
        case "-":
          label.setAttribute("class", "zotero-clicky zotero-clicky-minus");
          label.setAttribute("value", "-");
          label.style.opacity = "1";
          break
        case "":
          label.setAttribute("value", "");
          label.style.opacity = ".23";
          break
      }
    }

    let remove = async () => {
      ztoolkit.log("removeRelatedItem");
      const popunWin = new PanelStatus("Removing Item", {closeTime: -1})
        .createLine({ text: refText, type: "default" })
        .show()
      setState()

      let relatedItem = this.utils.searchRelatedItem(item, reference._item) as Zotero.Item
      if (!relatedItem) {
        popunWin.changeHeadline("Removed");
        (node.querySelector("#refresh-button") as XUL.Button).click()
        popunWin.startCloseTimer(3000)
        return
      }
      relatedItem.removeRelatedItem(item)
      item.removeRelatedItem(relatedItem)
      await item.saveTx()
      await relatedItem.saveTx()
      setState("+")
      popunWin.changeLine({ type: "success" })
      popunWin.startCloseTimer(3000)
    }

    let add = async (collections: undefined | number[] = undefined) => {
      let collapseText = (text: string) => {
        let n
        if (this.utils.isChinese(text)) {
          n = 15
        } else {
          n = 35
        }
        return text.length > n ? (text.slice(0, n) + "...") : text
      }
      let popupWin = (new PanelStatus("Searching Item",
        { closeTime: -1, closeOtherProgressWindows: true}))
        .createLine({ text: collapseText(reference.text!), type: "default" })
        .show()
      // 检查本地
      let refItem = reference._item || await this.utils.searchLibraryItem(reference)
      // 禁用按钮
      setState()
      if (refItem) {
        popupWin.changeHeadline("Existing Item")
        popupWin.changeLine({ text: collapseText(refItem.getField("title"))})
      } else {
        let info: ItemBaseInfo = this.utils.refText2Info(reference.text!);
        // DOI or arXiv
        {
          // DOI信息补全
          if (Object.keys(reference.identifiers).length == 0) {
            // 解析层没能可靠地认出这条引文（匹配度低于 MIN_SCORE）。这里再拿那个
            // 猜出来的标题去反查 DOI，只会把误差放大成一条错误的文库条目。
            if (reference.lowConfidence) {
              setState("+");
              popupWin.changeHeadline("Uncertain match")
              popupWin.changeLine({ text: "Could not identify this reference reliably", type: "fail" })
              popupWin.startCloseTimer(3000)
              return
            }
            popupWin.changeHeadline("Searching DOI")
            popupWin.changeLine({ text: collapseText(`Title: ${info.title!}`) })
            let DOI = (await this.utils.API.getTitleInfoByConnectedpapers(info.title))?.identifiers.DOI as string
            if (!this.utils.isDOI(DOI)) {
              setState("+");
              popupWin.changeLine({ type: "fail" })
              popupWin.startCloseTimer(3000)
              return
            }
            reference.identifiers = { DOI }
          }
          popupWin.changeHeadline("Creating Item")
          popupWin.changeLine({ text: collapseText(`${Object.keys(reference.identifiers)}: ${Object.values(reference.identifiers)[0]}`) })
          // done
          if (await this.utils.searchRelatedItem(item, refItem)) {
            popupWin.changeHeadline("Added Item")
            popupWin.changeLine({ type: "success" });
            popupWin.startCloseTimer(3000);
            (node.querySelector("#refresh-button") as XUL.Button).click();
            return
          }
          // search DOI in local
          try {
            // 目标文库跟着“正在读的这篇论文”走，而不是左侧栏当前选中的文库。
            refItem = await this.utils.createItemByZotero(
              reference.identifiers,
              (collections || item.getCollections()),
              item.libraryID,
            )
          } catch (e: any) {
            popupWin.changeLine({ type: "fail" })
            popupWin.startCloseTimer(3000)
            setState("+")
            ztoolkit.log(e)
            return
          }
        }
        for (let collectionID of (collections || item.getCollections())) {
          refItem.addToCollection(collectionID)
          await refItem.saveTx()
        }
      }
      popupWin.changeHeadline("Adding Item")
      popupWin.changeLine({ text: collapseText(refItem.getField("title")) })
      // addRelatedItem
      reference._item = refItem
      item.addRelatedItem(refItem)
      refItem.addRelatedItem(item)
      await item.saveTx()
      await refItem.saveTx()
      // button
      setState("-")
      popupWin.changeLine({ type: "success" })
      popupWin.startCloseTimer(3000)
      updateRowByItem(refItem)
    }

    let updateRowByItem = (refItem: Zotero.Item) => {
      box.style.opacity = "1";
      box.querySelector("img")?.setAttribute("src", refItem.getImageSrc())
      let alreadyRelated = this.utils.searchRelatedItem(item, refItem)
      if (alreadyRelated) {
        setState("-")
      }
    }

    let timer: undefined | number, tipUI: TipUI;
    if (notInLibarayOpacity < 1) {
      window.setTimeout(async () => {
        const refItem = reference._item || await this.utils.searchLibraryItem(reference) as Zotero.Item
        if (refItem) {
          updateRowByItem(refItem)
        }
      }, refIndex * 0)
    }
    // 鼠标进入浮窗展示
    box.addEventListener("mouseenter", () => {
      if (!Zotero.Prefs.get(`${config.addonRef}.isShowTip`)) { return }
      box.classList.add("active")
      let timeout = parseInt(Zotero.Prefs.get(`${config.addonRef}.showTipAfterMillisecond`) as string)
      const position = Zotero.Prefs.get("extensions.zotero.layout", true) == "stacked" ? "top center" : "left"
      timer = window.setTimeout(async () => {
        const winRect: Rect = document.documentElement.getBoundingClientRect()
        const rect = box.getBoundingClientRect()
        rect.x -= 5
        tipUI = this.showTipUI(rect, reference, position, idText)
        if (!box.classList.contains("active")) {
          tipUI.container.style.display = "none"
        }
      }, timeout);
    })

    box.addEventListener("mouseleave", () => {
      box.classList.remove("active")
      window.clearTimeout(timer);
      if (!tipUI) { return }
      const timeout = tipUI.removeTipAfterMillisecond
      tipUI.tipTimer = window.setTimeout(async () => {
        // 监测是否连续一段时间内无active
        for (let i = 0; i < timeout / 2; i++) {
          if (rows.querySelector(".active")) { return }
          await Zotero.Promise.delay(1 / 1000)
        }
        tipUI && tipUI.clear()
      }, timeout / 2)
    })

    label.addEventListener("click", async (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const value = label.getAttribute("value")
      if (value == "+") {
        if (event.ctrlKey || event.metaKey) {
          let rect = box.getBoundingClientRect()
          // 构建分类选择
          let menuPopup = document.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", 'menupopup') as XUL.MenuPopup;
          document.querySelector("#browser")!.append(menuPopup);
          // 只列出当前论文所在文库的分类——列别的文库的分类，选了也存不进去。
          let collections = Zotero.Collections.getByLibrary(item.libraryID);
          for (let col of collections) {
            let menuItem = Zotero.Utilities.Internal.createMenuForTarget(
              col,
              menuPopup,
              null as any,
              async (event: any, collection: any) => {
                if (event.target.tagName == 'menuitem') {
                  ztoolkit.log(collection)
                  menuPopup.remove()
                  await add([collection.id])
                  event.stopPropagation();
                }
              }
            );
            menuPopup.append(menuItem);
          }
          // @ts-ignore
          menuPopup.openPopupAtScreen(rect.left, rect.top + rect.height, true);
        } else {
          await add()
        }
      } else if (value == "-") {
        await remove()
      }
    })

    const rows = node.querySelector(".reference-grid")!

    rows.append(box, label);
    let referenceNum = rows.childNodes.length
    if (addSearch && referenceNum && !node.querySelector("#zoference-search")) { this.addSearch(node) }
    // 高度
    const relatedGrid = node.querySelector(".reference-grid") as HTMLDivElement
    relatedGrid.style.maxHeight = "60vh"
    return {box, label}
  }

  public addSearch(node: HTMLDivElement) {
    const searchBoxHeight = 10
    const searchBox = ztoolkit.UI.insertElementBefore({
      tag: "div",
      id: "zoference-search",
      classList: ["reference-search-box"],
      styles: {
        // width: "calc(100% - 35px)",
        height: `${searchBoxHeight}px`,
        padding: "5px",
        borderRadius: "5px",
        border: "1px solid #e0e0e0",
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        margin: ".5em 1em",
        opacity: "0.8"
      },
      children: [
        {
          tag: "div",
          styles: {
            width: `${searchBoxHeight}px`,
            height: `${searchBoxHeight}px`,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          },
          properties: {
            innerHTML: `<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="${searchBoxHeight}" height="${searchBoxHeight}"><path d="M1005.312 914.752l-198.528-198.464A448 448 0 1 0 0 448a448 448 0 0 0 716.288 358.784l198.4 198.4a64 64 0 1 0 90.624-90.432zM448 767.936A320 320 0 1 1 448 128a320 320 0 0 1 0 640z" fill="#5a5a5a"></path></svg>`
          }
        },
        {
          tag: "input",
          styles: {
            outline: "none",
            border: "none",
            width: "100%",
            margin: "0 5px"
          },
          listeners: [
            {
              type: "focus",
              listener: () => {
                searchBox.style.opacity = "1"
                searchBox.style.boxShadow = `0 0 0 1px rgba(0,0,0,0.5)`
              }
            },
            {
              type: "blur",
              listener: () => {
                searchBox.style.opacity = "0.8"
                searchBox.style.boxShadow = ``
              }
            },
            {
              type: "keyup",
              listener: async () => {
                const keyword = inputNode.value as string
                if (keyword.length > 0) {
                  clearNode.style.display = ""
                } else {
                  clearNode.style.display = "none"
                }
                //   let text = (event.target as any).value
                let keywords = keyword.split(/[ ,，]/).filter((e: any) => e)
                ztoolkit.log(keywords)
                node.querySelectorAll(".reference-grid *").forEach((e: any) => e.style.display = "")
                if (keywords.length == 0) {
                  return
                }
                node.querySelectorAll(".reference-grid .box").forEach((box: any) => {
                  let content = (box.querySelector("#reference-label") as any).textContent
                  let isAllMatched = true;
                  for (let i = 0; i < keywords.length; i++) {
                    isAllMatched = isAllMatched && content.toLowerCase().indexOf(keywords[i].toLowerCase()) >= 0
                  }
                  if (isAllMatched) {
                    ztoolkit.log(content)
                    box.style.display = ""
                    box.nextElementSibling.style.display = ""
                  } else {
                    box.style.display = "none"
                    box.nextElementSibling.style.display = "none"
                  }
                })
              }
            }
          ]
        },
        {
          tag: "div",
          classList: ["icon", "clear"],
          styles: {
            width: `${searchBoxHeight}px`,
            height: `${searchBoxHeight}px`,
            display: "none"
          },
          properties: {
            innerHTML: `<svg class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="${searchBoxHeight}" height="${searchBoxHeight}"><path d="M512.288 1009.984c-274.912 0-497.76-222.848-497.76-497.76s222.848-497.76 497.76-497.76c274.912 0 497.76 222.848 497.76 497.76s-222.848 497.76-497.76 497.76zM700.288 368.768c12.16-12.16 12.16-31.872 0-44s-31.872-12.16-44.032 0l-154.08 154.08-154.08-154.08c-12.16-12.16-31.872-12.16-44.032 0s-12.16 31.84 0 44l154.08 154.08-154.08 154.08c-12.16 12.16-12.16 31.84 0 44s31.872 12.16 44.032 0l154.08-154.08 154.08 154.08c12.16 12.16 31.872 12.16 44.032 0s12.16-31.872 0-44l-154.08-154.08 154.08-154.08z" fill="#5a5a5a" p-id="5698"></path></svg>`
          },
          listeners: [
            {
              type: "click",
              listener: async () => {
                inputNode.value = ""
                clearNode.style.display = "none"
                node.querySelectorAll(".reference-grid *").forEach((e: any) => e.style.display = "")
              }
            }
          ]
        },
      ]
    }, node.querySelector(".grid")!) as HTMLDivElement;
    const inputNode = searchBox.querySelector("input") as HTMLInputElement
    const clearNode = searchBox.querySelector(".clear") as HTMLInputElement
  }
}
