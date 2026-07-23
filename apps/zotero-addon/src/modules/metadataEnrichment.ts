/**
 * 文库条目的 DOI / Semantic Scholar Paper ID 补全。
 *
 * 入口只负责拿当前选择；查询、交叉评分、冲突复核和写回都留在本模块，避免继续膨胀
 * views.ts。Semantic Scholar 搜索与 Crossref 结果会合并评分，只有高置信度且候选领先
 * 明显时才自动写入；已有标识符冲突或候选不够唯一时必须让用户确认。
 */

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  bareDOI,
  getJSON,
  MAILTO,
} from "./scholarlyHttp";
import {
  fetchSemanticScholarPaper,
  fetchSemanticScholarPaperByDOI,
  searchSemanticScholarPapers,
  type SemanticScholarPaper,
} from "./semanticScholarApi";
import {
  readItemPaperIdentifiers,
  S2_ID_ALIASES,
  S2_ID_FIELD,
} from "./itemIdentifiers";

const AUTO_SCORE = 0.92;
const REVIEW_SCORE = 0.78;
const AUTO_MARGIN = 0.05;

interface PaperCandidate {
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  doi?: string;
  paperId?: string;
  score: number;
  sources: Set<string>;
}

interface ItemMetadata {
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
  paperId?: string;
}

interface Resolution {
  item: ItemMetadata;
  best?: PaperCandidate;
  secondScore: number;
  currentIdentifierCandidate?: PaperCandidate;
}

type ItemOutcome = "updated" | "unchanged" | "skipped";
type ReviewAction = "apply" | "keep" | "skip";

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactText(value: string): string {
  return normalizeText(value).replace(/\s+/g, "");
}

/** 标题很短，二维编辑距离只会浪费内存；保留一行即可。 */
function levenshteinRatio(left: string, right: string): number {
  const a = compactText(left).slice(0, 500);
  const b = compactText(right).slice(0, 500);
  if (!a || !b) { return 0; }
  if (a === b) { return 1; }
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) { previous[j] = current[j]; }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function titleSimilarity(left: string, right: string): number {
  const aTokens = normalizeText(left).split(" ").filter(Boolean);
  const bTokens = normalizeText(right).split(" ").filter(Boolean);
  if (!aTokens.length || !bTokens.length) { return 0; }
  const bSet = new Set(bTokens);
  const overlap = aTokens.filter((token) => bSet.has(token)).length;
  const tokenScore = (2 * overlap) / (aTokens.length + bTokens.length);
  return Math.max(tokenScore, levenshteinRatio(left, right));
}

function authorPairScore(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) { return 0; }
  const compactA = a.replace(/\s+/g, "");
  const compactB = b.replace(/\s+/g, "");
  if (compactA === compactB) { return 1; }
  const lastA = a.split(" ").filter(Boolean).pop() || "";
  const lastB = b.split(" ").filter(Boolean).pop() || "";
  if (lastA.length > 1 && lastA === lastB) { return 0.9; }
  if (Math.min(compactA.length, compactB.length) >= 4 &&
      (compactA.includes(compactB) || compactB.includes(compactA))) {
    return 0.8;
  }
  return 0;
}

function authorSimilarity(itemAuthors: string[], candidateAuthors: string[]): number {
  if (!itemAuthors.length || !candidateAuthors.length) { return 0; }
  const sample = itemAuthors.slice(0, 3);
  const total = sample.reduce((sum, author) => {
    return sum + Math.max(...candidateAuthors.map((other) => authorPairScore(author, other)));
  }, 0);
  return total / sample.length;
}

function scoreCandidate(item: ItemMetadata, candidate: PaperCandidate): number {
  let totalWeight = 0.75;
  let weightedScore = 0.75 * titleSimilarity(item.title, candidate.title);
  if (item.authors.length) {
    totalWeight += 0.15;
    weightedScore += 0.15 * authorSimilarity(item.authors, candidate.authors);
  }
  if (item.year) {
    totalWeight += 0.10;
    weightedScore += 0.10 * (item.year === candidate.year ? 1 : 0);
  }
  return Math.max(0, Math.min(1, weightedScore / totalWeight));
}

function externalID(paper: SemanticScholarPaper, name: string): string | undefined {
  const entry = Object.entries(paper.externalIds || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ? String(entry[1]) : undefined;
}

function fromSemanticScholar(paper?: SemanticScholarPaper): PaperCandidate | undefined {
  const title = String(paper?.title || "").trim();
  if (!paper || !title) { return; }
  const doi = externalID(paper, "DOI");
  return {
    title,
    authors: Array.isArray(paper.authors)
      ? paper.authors.map((author) => String(author?.name || "").trim()).filter(Boolean)
      : [],
    year: paper.year == null ? undefined : String(paper.year),
    venue: paper.venue ? String(paper.venue) : undefined,
    doi: doi ? bareDOI(doi) : undefined,
    paperId: typeof paper.paperId === "string" ? paper.paperId.trim() : undefined,
    score: 0,
    sources: new Set(["Semantic Scholar"]),
  };
}

function fromCrossref(work: any): PaperCandidate | undefined {
  const title = Array.isArray(work?.title) ? work.title[0] : work?.title;
  if (!title) { return; }
  const year = work.issued?.["date-parts"]?.[0]?.[0]
    ?? work.published?.["date-parts"]?.[0]?.[0];
  const venue = Array.isArray(work["container-title"])
    ? work["container-title"][0]
    : work["container-title"];
  return {
    title: String(title),
    authors: Array.isArray(work.author)
      ? work.author.map((author: any) => {
        return [author?.given, author?.family].filter(Boolean).join(" ").trim();
      }).filter(Boolean)
      : [],
    year: year == null ? undefined : String(year),
    venue: venue ? String(venue) : undefined,
    doi: work.DOI ? bareDOI(String(work.DOI)) : undefined,
    score: 0,
    sources: new Set(["Crossref"]),
  };
}

async function searchCrossref(item: ItemMetadata): Promise<PaperCandidate[]> {
  if (!item.title) { return []; }
  const bibliographic = [item.title, item.authors[0], item.year].filter(Boolean).join(" ");
  const response = await getJSON(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(bibliographic)}` +
      `&rows=5&select=DOI,title,author,issued,container-title,type` +
      `&mailto=${encodeURIComponent(MAILTO)}`,
    { tag: "metadata-crossref" },
  );
  return Array.isArray(response?.message?.items)
    ? response.message.items.map(fromCrossref).filter(Boolean) as PaperCandidate[]
    : [];
}

function sameDOI(left?: string, right?: string): boolean {
  return !!left && !!right && bareDOI(left).toLowerCase() === bareDOI(right).toLowerCase();
}

function samePaperID(left?: string, right?: string): boolean {
  return !!left && !!right && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function candidatesMatch(left: PaperCandidate, right: PaperCandidate): boolean {
  if (left.doi && right.doi) { return sameDOI(left.doi, right.doi); }
  if (left.paperId && right.paperId) { return samePaperID(left.paperId, right.paperId); }
  const yearsCompatible = !left.year || !right.year || left.year === right.year;
  return yearsCompatible && titleSimilarity(left.title, right.title) >= 0.985;
}

function mergeInto(candidates: PaperCandidate[], incoming?: PaperCandidate): void {
  if (!incoming) { return; }
  const existing = candidates.find((candidate) => candidatesMatch(candidate, incoming));
  if (!existing) {
    candidates.push(incoming);
    return;
  }
  existing.paperId ||= incoming.paperId;
  existing.doi ||= incoming.doi;
  existing.year ||= incoming.year;
  existing.venue ||= incoming.venue;
  if (incoming.authors.length > existing.authors.length) { existing.authors = incoming.authors; }
  incoming.sources.forEach((source) => existing.sources.add(source));
}

function readItemMetadata(item: Zotero.Item): ItemMetadata {
  const identifiers = readItemPaperIdentifiers(item);
  const creators = item.getCreators();
  const authors = creators.map((creator) => {
    return [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim();
  }).filter(Boolean);
  let year = "";
  try { year = item.getField("year") || ""; } catch { /* no mapped date field */ }
  if (!year) { year = (item.getField("date") || "").match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1] || ""; }
  return {
    title: item.getField("title") || item.getDisplayTitle() || "",
    authors,
    year: year || undefined,
    doi: identifiers.doi,
    paperId: identifiers.semanticScholarPaperId,
  };
}

function replaceExtraValue(extra: string, aliases: string[], canonical: string, value: string): string {
  const lines = String(extra || "").split(/\r?\n/);
  const lowerAliases = new Set(aliases.map((alias) => alias.toLowerCase()));
  let inserted = false;
  const next: string[] = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    const key = separator >= 0 ? line.slice(0, separator).trim().toLowerCase() : "";
    if (!lowerAliases.has(key)) {
      next.push(line);
      continue;
    }
    if (!inserted) {
      next.push(`${canonical}: ${value}`);
      inserted = true;
    }
  }
  if (!inserted) {
    if (next.length && next[next.length - 1].trim()) { next.push(""); }
    next.push(`${canonical}: ${value}`);
  }
  return next.join("\n").replace(/^\s+|\s+$/g, "");
}

function removeExtraValue(extra: string, aliases: string[]): string {
  const lowerAliases = new Set(aliases.map((alias) => alias.toLowerCase()));
  return String(extra || "").split(/\r?\n/).filter((line) => {
    const separator = line.indexOf(":");
    const key = separator >= 0 ? line.slice(0, separator).trim().toLowerCase() : "";
    return !lowerAliases.has(key);
  }).join("\n").replace(/^\s+|\s+$/g, "");
}

async function writeIdentifiers(
  item: Zotero.Item,
  candidate: PaperCandidate,
  missingOnly = false,
): Promise<boolean> {
  const current = readItemMetadata(item);
  let extra = item.getField("extra") || "";
  let changed = false;

  if (candidate.doi && (!missingOnly || !current.doi) && !sameDOI(current.doi, candidate.doi)) {
    try {
      item.setField("DOI", candidate.doi);
      const withoutDuplicate = removeExtraValue(extra, ["DOI"]);
      if (withoutDuplicate !== extra) { extra = withoutDuplicate; }
    } catch {
      extra = replaceExtraValue(extra, ["DOI"], "DOI", candidate.doi);
    }
    changed = true;
  }

  if (candidate.paperId && (!missingOnly || !current.paperId) &&
      !samePaperID(current.paperId, candidate.paperId)) {
    extra = replaceExtraValue(extra, S2_ID_ALIASES, S2_ID_FIELD, candidate.paperId);
    changed = true;
  }

  if (!changed) { return false; }
  if (extra !== item.getField("extra")) { item.setField("extra", extra); }
  await item.saveTx();
  return true;
}

function candidateWouldChange(item: ItemMetadata, candidate: PaperCandidate): boolean {
  return (!!candidate.doi && !sameDOI(item.doi, candidate.doi)) ||
    (!!candidate.paperId && !samePaperID(item.paperId, candidate.paperId));
}

function findCurrentIdentifierCandidate(
  candidates: PaperCandidate[],
  item: ItemMetadata,
): PaperCandidate | undefined {
  return candidates.find((candidate) => {
    return (item.doi && sameDOI(item.doi, candidate.doi)) ||
      (item.paperId && samePaperID(item.paperId, candidate.paperId));
  });
}

/**
 * 已有标识符存在时，候选必须提供同类标识符才能参与“替换”排名。否则把只有 S2 ID 的
 * 候选写到已有 DOI 旁边（或反过来），会制造一条内部自相矛盾的 Zotero 记录。
 */
function candidateIsViable(candidate: PaperCandidate, item: ItemMetadata): boolean {
  return (!item.doi || !!candidate.doi) && (!item.paperId || !!candidate.paperId);
}

async function resolveItem(item: Zotero.Item): Promise<Resolution> {
  const metadata = readItemMetadata(item);
  const candidates: PaperCandidate[] = [];
  const crossrefPromise = searchCrossref(metadata);

  // 同一条记录最多需要三次 S2 请求。匿名 API 很容易被突发请求限流，因此严格串行。
  if (metadata.doi) {
    mergeInto(candidates, fromSemanticScholar(
      await fetchSemanticScholarPaperByDOI(metadata.doi),
    ));
  }
  if (metadata.paperId &&
      !candidates.some((candidate) => samePaperID(candidate.paperId, metadata.paperId))) {
    mergeInto(candidates, fromSemanticScholar(
      await fetchSemanticScholarPaper(metadata.paperId),
    ));
  }
  if (metadata.title) {
    const searchResults = await searchSemanticScholarPapers(metadata.title, 5);
    searchResults.map(fromSemanticScholar).forEach((candidate) => mergeInto(candidates, candidate));
  }

  (await crossrefPromise).forEach((candidate) => mergeInto(candidates, candidate));
  candidates.forEach((candidate) => { candidate.score = scoreCandidate(metadata, candidate); });
  candidates.sort((left, right) => right.score - left.score);

  // Crossref 的最佳候选可能还没有 S2 ID；只对可进入复核区间的候选多做一次精确查询。
  const identityLookupCandidate = candidates.find(
    (candidate) => candidate.doi && !candidate.paperId && candidate.score >= REVIEW_SCORE,
  );
  if (identityLookupCandidate?.doi) {
    mergeInto(candidates, fromSemanticScholar(
      await fetchSemanticScholarPaperByDOI(identityLookupCandidate.doi),
    ));
    candidates.forEach((candidate) => { candidate.score = scoreCandidate(metadata, candidate); });
    candidates.sort((left, right) => right.score - left.score);
  }

  const ranked = candidates.filter((candidate) => candidateIsViable(candidate, metadata));
  const best = ranked[0];

  return {
    item: metadata,
    best,
    secondScore: ranked[1]?.score || 0,
    currentIdentifierCandidate: findCurrentIdentifierCandidate(candidates, metadata),
  };
}

function fieldRow(label: string, value?: string): any {
  return {
    tag: "div",
    namespace: "html",
    styles: { display: "grid", gridTemplateColumns: "105px 1fr", gap: "8px", marginBottom: "7px" },
    children: [
      { tag: "strong", namespace: "html", properties: { textContent: label } },
      { tag: "span", namespace: "html", properties: { textContent: value || "—" },
        styles: { overflowWrap: "anywhere" } },
    ],
  };
}

function comparisonCard(
  heading: string,
  values: { title: string; authors: string[]; year?: string; doi?: string; paperId?: string },
  score?: number,
): any {
  const children: any[] = [
    { tag: "h2", namespace: "html", properties: { textContent: heading },
      styles: { fontSize: "16px", margin: "0 0 14px" } },
    fieldRow(getString("metadata-enrich-field-title"), values.title),
    fieldRow(getString("metadata-enrich-field-authors"), values.authors.slice(0, 4).join(", ")),
    fieldRow(getString("metadata-enrich-field-year"), values.year),
    fieldRow("DOI", values.doi),
    fieldRow("Semantic Scholar Paper ID", values.paperId),
  ];
  if (score != null) {
    children.push(fieldRow(
      getString("metadata-enrich-field-confidence"),
      `${Math.round(score * 100)}%`,
    ));
  }
  return {
    tag: "div",
    namespace: "html",
    styles: {
      boxSizing: "border-box",
      width: "350px",
      minHeight: "285px",
      padding: "16px",
      border: "1px solid rgba(128, 128, 128, 0.35)",
      borderRadius: "8px",
    },
    children,
  };
}

async function reviewCandidate(
  current: ItemMetadata,
  candidate: PaperCandidate,
  currentIdentifierCandidate: PaperCandidate | undefined,
  hasExistingIdentifier: boolean,
): Promise<ReviewAction> {
  const currentSide = currentIdentifierCandidate || current;
  const currentHeading = currentIdentifierCandidate
    ? `${getString("metadata-enrich-current-identifier-record")} · ` +
      Array.from(currentIdentifierCandidate.sources).join(" + ")
    : getString("metadata-enrich-current-record");
  const dialogData: Record<string, any> = {};
  let dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      styles: {
        width: "718px",
        padding: "4px",
      },
      children: [
        {
          tag: "p",
          namespace: "html",
          properties: {
            textContent: `${getString("metadata-enrich-review-item", {
              args: { title: current.title },
            })}\n\n${getString(
              hasExistingIdentifier
                ? "metadata-enrich-review-conflict"
                : "metadata-enrich-review-ambiguous",
            )}`,
          },
          styles: { margin: "0 0 14px", lineHeight: "1.5", whiteSpace: "pre-wrap" },
        },
        {
          tag: "div",
          namespace: "html",
          styles: { display: "flex", gap: "14px", alignItems: "stretch" },
          children: [
            comparisonCard(
              currentHeading,
              currentSide,
              currentIdentifierCandidate?.score,
            ),
            comparisonCard(
              `${getString("metadata-enrich-candidate-record")} · ` +
                Array.from(candidate.sources).join(" + "),
              candidate,
              candidate.score,
            ),
          ],
        },
      ],
    }, false)
    .addButton(getString("metadata-enrich-use-candidate"), "apply");
  if (hasExistingIdentifier) {
    dialog = dialog.addButton(getString("metadata-enrich-keep-current"), "keep");
  }
  dialog = dialog
    .addButton(getString("metadata-enrich-skip-item"), "skip")
    .setDialogData(dialogData)
    .open(getString("metadata-enrich-dialog-title"), {
      centerscreen: true,
      resizable: true,
      fitContent: true,
    });
  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  const action = dialogData._lastButtonId;
  return action === "apply" || action === "keep" ? action : "skip";
}

export default class MetadataEnrichment {
  private registeredMenuID?: string;
  private running = false;

  register(win: Window): void {
    if (this.registeredMenuID) { return; }
    const menuManager = (Zotero as any).MenuManager;
    if (!menuManager?.registerMenu) {
      ztoolkit.log("[metadata-enrichment] Zotero.MenuManager is unavailable");
      return;
    }
    // MenuManager 只挂 data-l10n-id，不代插件加载自己的 Fluent 文件。
    (win as any).MozXULElement?.insertFTLIfNeeded?.(`${config.addonRef}-addon.ftl`);
    this.registeredMenuID = menuManager.registerMenu({
      menuID: `${config.addonRef}-metadata-enrichment`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [{
        menuType: "menuitem",
        l10nID: `${config.addonRef}-metadata-enrich-menu`,
        onShowing: (_event: Event, context: any) => {
          context.setVisible(!this.running && this.getEligibleItems(context.items).length > 0);
        },
        onCommand: (event: Event, context: any) => {
          const target = event.currentTarget as Element | null;
          const win = target?.ownerDocument?.defaultView || Zotero.getMainWindow();
          void this.runForItems(this.getEligibleItems(context.items), win);
        },
      }],
    });
  }

  unregister(_win: Window): void {
    this.unregisterAll();
  }

  unregisterAll(): void {
    if (!this.registeredMenuID) { return; }
    (Zotero as any).MenuManager?.unregisterMenu?.(this.registeredMenuID);
    this.registeredMenuID = undefined;
  }

  private getEligibleItems(selected: Zotero.Item[] | undefined): Zotero.Item[] {
    const unique = new Map<string, Zotero.Item>();
    for (const selectedItem of selected || []) {
      const item = selectedItem.isRegularItem()
        ? selectedItem
        : selectedItem.parentItem?.isRegularItem()
          ? selectedItem.parentItem
          : undefined;
      if (!item) { continue; }
      unique.set(`${item.libraryID}/${item.key}`, item);
    }
    return Array.from(unique.values());
  }

  private async enrichOne(item: Zotero.Item): Promise<ItemOutcome> {
    if (!item.isEditable()) { return "skipped"; }
    const resolution = await resolveItem(item);
    const { best, secondScore } = resolution;
    if (!best || (!best.doi && !best.paperId)) {
      return "skipped";
    }
    const doiConflict = !!resolution.item.doi && !!best.doi &&
      !sameDOI(resolution.item.doi, best.doi);
    const idConflict = !!resolution.item.paperId && !!best.paperId &&
      !samePaperID(resolution.item.paperId, best.paperId);
    if (best.score < REVIEW_SCORE) {
      const current = resolution.currentIdentifierCandidate;
      if (!current) { return "skipped"; }
      return await writeIdentifiers(item, current, true) ? "updated" : "unchanged";
    }
    if (!doiConflict && !idConflict && resolution.currentIdentifierCandidate &&
        candidatesMatch(best, resolution.currentIdentifierCandidate)) {
      return await writeIdentifiers(item, best, true) ? "updated" : "unchanged";
    }
    if (!candidateWouldChange(resolution.item, best)) { return "unchanged"; }

    const ambiguous = best.score < AUTO_SCORE || best.score - secondScore < AUTO_MARGIN;
    if (doiConflict || idConflict || ambiguous) {
      const hasExisting = !!resolution.item.doi || !!resolution.item.paperId;
      const action = await reviewCandidate(
        resolution.item,
        best,
        resolution.currentIdentifierCandidate,
        hasExisting,
      );
      if (action === "skip") { return "skipped"; }
      if (action === "keep") {
        const current = resolution.currentIdentifierCandidate;
        if (!current) { return "unchanged"; }
        return await writeIdentifiers(item, current, true) ? "updated" : "unchanged";
      }
    }
    return await writeIdentifiers(item, best) ? "updated" : "unchanged";
  }

  private async runForItems(items: Zotero.Item[], win: Window): Promise<void> {
    if (!items.length || this.running) { return; }
    this.running = true;
    const progress = new ztoolkit.ProgressWindow(getString("metadata-enrich-menu-label"), {
      window: win,
      closeTime: -1,
      closeOtherProgressWindows: true,
    }).createLine({
      text: getString("metadata-enrich-starting"),
      progress: 0,
    }).show(-1);
    const stats = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        progress.changeLine({
          text: getString("metadata-enrich-progress", {
            args: {
              current: index + 1,
              total: items.length,
              title: (item.getField("title") || item.getDisplayTitle()).slice(0, 80),
            },
          }),
          progress: Math.round((index / items.length) * 100),
        });
        try {
          const outcome = await this.enrichOne(item);
          stats[outcome] += 1;
        } catch (error) {
          stats.failed += 1;
          Zotero.logError(error as Error);
        }
      }
      progress.changeLine({
        type: stats.failed ? "fail" : "success",
        text: getString("metadata-enrich-finished", { args: stats }),
        progress: 100,
      }).startCloseTimer(stats.failed ? 10000 : 7000);
    } finally {
      this.running = false;
    }
  }
}
