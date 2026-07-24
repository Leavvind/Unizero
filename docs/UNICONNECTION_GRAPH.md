# UniConnection Graph — Phase 4 设计与施工方案

> 交接文档。目标读者是实现者（Codex）。自包含，不依赖对话上下文。
> 前置：[UNICONNECTION.md](UNICONNECTION.md)（Phase 1–3 已完成：派生倒排索引 + Relation 面板）。
> 一句话：**给 Literature Explorer 加图视图——全库总览图（Obsidian 手感）+ 单篇 Ego 图（Connected Papers 手感），
> 数据全部从已有的 UniConnection 索引派生，渲染用本地打包的 force-graph。**
>
> **状态：§9 第 1–4 步全部完成**，待真机验证手感。
> - 数据层 `libraryGraph` / `egoGraph` + 单测（`tests/uniConnectionGraph.test.ts`）
> - vendored force-graph + [literature-graph.js](../apps/zotero-addon/addon/chrome/content/literature-graph.js) 渲染门面
> - 全库总览图（Graph⇄Table 切换，表格降为可折叠管理面）+ 详情页 Ego 图标签
> - 收尾：图/表筛选联动（搜索框、连线类型、最小共同参考数）、布局坐标持久化
>
> 布局落盘在 `<dataDir>/unizero/graph/<libraryID>.json`，**刻意放在分片树之外** —— 那里的文件按 item 键入并会被
> `sweep()` 在条目消失时删除，布局放进去会每次启动被清掉。

---

## 1. 已定决策（来自需求方拍板）

1. **Ego 图仅库内**：单篇为中心的图只含 Zotero 库内论文。库外 ghost 发现节点**延后**（本期不做）。
2. **渲染库 = `force-graph`（Vasturiano，2D canvas，MIT）**：自带 hover/拖拽/缩放/link 粒子动感，最接近目标手感。
   数百~上千节点足够。若将来上千节点不够顺滑，再换 WebGL（Cosmograph/Sigma）——**数据层必须与渲染器解耦**以便低成本替换。
3. **两块图一起做**：整图构造器 + 全库总览视图 + 详情页 Ego 视图，一并交付。

⚠ **不要 vendored Obsidian 的图代码**（如 zotero-style 那种「Obsidian source code」）——Obsidian 应用代码闭源、禁止再分发。
目标手感来自 canvas + d3-force，`force-graph` 已经给全了，直接用它。

---

## 2. 放哪里：映射到现有两个视图

Explorer 现为两视图（见 `addon/chrome/content/literature-explorer.xhtml`）：
- `#collection-view`：全库管理表（Title/Creator/Year/DateAdded/Markdown/References/Citations）。
- `#detail-view`：单篇的 References / **Relation** / Citations 标签页（Relation 已是 Phase 3 产物）。

| 目标 | 落点 | 角色 |
|---|---|---|
| 全库总览图（Obsidian 式） | `#collection-view` 加 **Graph⇄Table** 模式切换 | 图为主视图，表降为**可折叠的管理面** |
| 单篇 Ego 图（Connected Papers 式） | `#detail-view` 新增 **Graph** 标签（置于 References 之前或并列） | 以选中 Paper 为中心的库内邻域图 |

---

## 3. 交互模型（Obsidian 三段式，别让单击直接跳转）

- **hover**：高亮邻居子图 + 浮出预览卡——**复用现有 `.row-preview`**（xhtml 里已有样式与逻辑）。
- **单击**：选中节点 + 图重心平移到它（recenter）；与表格选中双向同步。
- **双击**：才是「打开」——等价于现在表格里 Title 链接的动作。
  - 全库图双击一个节点 → 进入该 Paper 的 `#detail-view`。
  - 「Show in Zotero」用已有 `api.selectItem(itemID)`（[literatureExplorer.ts:265](apps/zotero-addon/src/ui/literatureExplorer.ts)）。
- **表格与图是同一份筛选结果的两种呈现**：年份 / 来源 / 标签 / 边类型（cites vs coupled）/ 最小耦合权重等筛选对两者同时生效。这正是需求方要的「表格担任管理职能」。

---

## 4. 视觉编码（Connected Papers 式）

- **节点大小** = 被引数 `citations`（若库内论文无该字段，回退到**库内入度** = 有多少库内论文引用它）。
- **节点颜色** = 年份（顺序色阶）。
- **位置** = 力导向布局，**耦合权重作为吸引力**（共享参考多的聚在一起）。
- **边**：`cites` 有向（可加方向性 link 粒子体现「动感」）；`coupled` 无向，**透明度/粗细 = 耦合权重**。
- 主题：canvas 颜色必须读 xhtml 里现有 CSS 变量（`--accent/--fg/--muted/--border/--green/--orange` 等，含 `@media (prefers-color-scheme: dark)`），并在主题切换时重绘。

---

## 5. 数据层：UniConnection 新增整图构造器

现有索引（见 [uniConnection.ts](apps/zotero-addon/src/modules/uniConnection.ts) 的 `LibraryIndex`）已有 `forward` / `inverted` / `selfEdge` / `edgeOwner`，两张图**全部可直接派生，无需新抓取**。

### 5.1 图数据形状（纯数据，可序列化）

**分工**：UniConnection 只产出**拓扑字段**（`id`/`itemKey`/`degree`/`isCenter`）——它刻意不读任何 Zotero item 字段（保持纯派生、可无 Zotero 单测）。**元数据由 Views 层富化**：`views.getLiteratureGraph` 拿到拓扑后，用与 `getLiteratureCollectionSnapshot` 同源的方式补 `title`/`year`/`citations`/`hasPDF`/`hasMarkdown`。

```ts
// UniConnection 产出（已实现）：
export interface GraphNode {
  id: ScopedItemKey;        // `${libraryID}:${itemKey}`
  itemKey: string;
  degree: number;           // 库内 in+out 度，用于定大小与去杂
  isCenter?: boolean;       // 仅 ego 图
}
// Views 富化后追加：title / year? / citations? / hasPDF / hasMarkdown
export interface GraphEdge {
  source: ScopedItemKey;
  target: ScopedItemKey;
  type: "cites" | "coupled";
  weight: number;           // cites=1；coupled=共享参考数
  directed: boolean;        // cites=true；coupled=false
}
export interface LiteratureGraph {
  scope: { libraryID: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  center?: ScopedItemKey;   // ego 图为中心节点
}
```

### 5.2 `libraryGraph(libraryID): LiteratureGraph`

- `await indexFor(libraryID)` 惰性建好索引。
- **节点**：遍历 `index.items` 的每个 scopedKey，解析回 Zotero item 取 title/year/hasPDF/hasMarkdown（与 `getLiteratureCollectionSnapshot` 取元数据同源，避免两处口径不一）。
- **cites 边**（库内引用）：对每个 A，遍历 `forward[A]` 的边 e，若 `edgeOwner.has(e)` 且 `edgeOwner(e) !== A` → 有向边 `A → edgeOwner(e)`。
- **coupling 边**（文献耦合）：遍历 `inverted`，对每条边 e，令 `S = inverted[e]`；
  - **超级 hub 上限**：若 `|S| > COUPLING_HUB_CAP`（建议 200）则跳过——人人都引的方法论论文会造出稠密团，既 O(n²) 又无信息量。
  - 否则对 S 内每个无序对 (u,v) 累加 `weight[(u,v)] += 1`。
  - 只发出 `weight ≥ COUPLING_MIN_WEIGHT`（大库建议 2）的耦合边，控制可读性。
- **degree**：由上面两类边累计。

### 5.3 `egoGraph(item, opts?): LiteratureGraph`（仅 1 跳，仅库内）

- center = `libraryItemIdentity(item)`，`isCenter=true`。
- **被引**（谁引用了本篇）：`relationsOf(item)` → 每个邻居有向边 `neighbor → center`。
- **引用**（本篇引了库内谁）：遍历 `forward[center]` 的边 e，`edgeOwner.has(e)` → 有向边 `center → edgeOwner(e)`。
- **耦合**：`coupledWith(item, EGO_COUPLING_LIMIT)` → 无向边 `center — neighbor`（weight=shared）。
- 节点 = center + 上述所有邻居去重。**不含库外 ghost 节点**（本期决策）。

### 5.4 与渲染器解耦

`libraryGraph`/`egoGraph` 只返回上面的纯 `LiteratureGraph`。渲染端只消费这个结构，**不得**依赖 force-graph 特有字段——这样将来换 WebGL 只改渲染端。

---

## 6. 数据流：接进 Explorer 的 api 桥

数据桥是 `explorerApi()` 返回的纯对象（[literatureExplorer.ts:176](apps/zotero-addon/src/ui/literatureExplorer.ts)），窗口通过 `window.arguments[0].api` 拿到。**不是** `contracts.ts`（那是给 Python runtime 的 HTTP 契约，无关）。

新增（照搬 `collectionSnapshot` / `snapshot` 的写法）：
- `api.graph()` → `explorerViews.getLiteratureGraph(scope)` → `uniConnection.libraryGraph(scope.libraryID)`。
- `api.egoGraph(itemKey)` → `explorerViews.getLiteratureEgoGraph(contextItem(itemKey))` → `uniConnection.egoGraph(item)`。
- 在 `views.ts` 里加对应生产端（与 `getLiteratureCollectionSnapshot` 并列）。
- `strings()` 里补图相关文案（边类型、图/表切换、空态等）；沿用已有 `relationCites/relationCoupled/relationBoth/sharedColumn/mostShared`。

---

## 7. 渲染器接入：force-graph（vendored）

- 取 `force-graph` 的 **UMD standalone 构建**（`dist/force-graph.min.js`，全局 `window.ForceGraph`，MIT，内含 d3-force/zoom/drag），
  放到 `addon/chrome/content/vendor/force-graph.min.js`（与现有 chrome 内容同目录，自动经 `chrome://<addonRef>/content/` 暴露）。
- 在 `literature-explorer.xhtml` 的 `literature-explorer.js` **之前**加 `<script src="vendor/force-graph.min.js"></script>`。
- **自包含约束**：不得走 CDN / 外部 fetch；整个文件本地打包（Zotero 离线可用 + CSP）。
- 新建 **`addon/chrome/content/literature-graph.js`**（纯 JS，与 literature-explorer.js 同风格），由 literature-explorer.js 调用。它负责：
  - 在容器 div 里建 `ForceGraph()` 实例，消费 `LiteratureGraph`；
  - `nodeCanvasObject`：半径由 citations/degree 定，填充由年份色阶定；
  - link：`cites` 有向 + 可选方向粒子，`coupled` 按 weight 定透明度；
  - hover→高亮邻居 + 复用 `.row-preview`；单击→选中+recenter；双击→打开；
  - 读 CSS 变量上色，响应 `prefers-color-scheme`。
- **DOM 改动**：`#collection-view` 加图容器 + Graph⇄Table 切换（图为主、表可折叠）；`#detail-view` 加 Graph 标签 + 图容器。

---

## 8. 关键约束与坑

1. **coupling 超级 hub 上限**（§5.2）：不设会 O(n²) 爆炸且拉出无信息量的稠密团。
2. **节点身份 = scopedKey ↔ itemKey**：打开/定位统一用 `${libraryID}:${itemKey}` 解析回 Zotero item；复用 `Zotero.Items.getByLibraryAndKey` 与 `api.selectItem`。
3. **大图可读性**：标签**去杂**（缩放/hover 才显全标签，否则重叠成糊——需求方那张 Obsidian 图能全显是因为库小）；配合筛选（边类型 / 最小耦合权重 / 年份）避免「毛球」。
4. **哑边限制延续**（见 UNICONNECTION.md §7）：无 DOI/arXiv/S2 的论文进不了边，会是孤立节点——预期行为，不是 bug。
5. **不阻塞 UI**：首次 `graph()` 会惰性全库建索引（大库有秒级延迟），渲染前显示 loading；力模拟异步跑。
6. **布局坐标缓存（收尾项）**：力模拟稳定后把 `id→{x,y}` 按 libraryID 存起来，重开不必重跑（Obsidian/Connected Papers 都持久化布局）。接上 UNICONNECTION.md 里延后的落盘水位线。首版可先每次重跑，列为 polish。
7. **渲染器解耦**（§5.4）：为将来换 WebGL 留路。

---

## 9. 施工分步（虽「两个一起」，内部仍按此序）

1. **数据层**：`uniConnection.libraryGraph` + `egoGraph`；`views.ts` 生产端；`api.graph()`/`egoGraph()`；strings。可无 UI 单测。
2. **vendored force-graph** + xhtml 挂载 + `literature-graph.js` 骨架，先把**全库图**画出来。
3. **详情页 Ego 图**：接 `api.egoGraph`，节点 open/select、hover 预览。
4. **收尾**：图/表切换与折叠、共享筛选、标签去杂、主题响应、布局缓存。

---

## 10. 验收与测试

- **单测（补上 UNICONNECTION.md 指出的测试缺口，从这里起头）**：
  - cites 边 ⇔ `A.forward ∋ B.selfEdge`；coupling 权重 = 共享参考数；无自环；ego 图中心不出现在自己的邻居集；hub 上限生效。
- **手动**：在 PEAD 库上开全库图，聚类是否符合直觉；双击进详情页 Ego 图；hover/单击/双击语义正确；明暗主题都正常。
- **性能**：数百~上千节点交互流畅；若卡顿，先上布局缓存，再考虑 §1 决策里的 WebGL 替换。

---

## 11. 明确不做 / 延后

- ❌ 库外 ghost 发现节点（Connected Papers 式「你没有的论文」）——本期不做，未来复用 References/Citations 缓存再加。
- ✅ 布局坐标持久化：已实现（见文首状态）。种子式恢复——存的坐标只作模拟起点，过期或残缺也会自行收敛，因此不做校验。
- ⏳ WebGL 渲染器：仅当上千节点不够顺滑时替换；数据层已解耦以便低成本切换。
- ⏳ 2 跳及以上 Ego 图：首版仅 1 跳。
