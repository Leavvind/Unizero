# UniConnection Graph — Phase 4 设计与施工方案

> 交接文档（中文）。自包含，不依赖对话上下文。
> 前置：[UNICONNECTION.md](UNICONNECTION.md)（派生倒排索引 + Relation 面板）。
> 一句话：**给 Literature Explorer 加图视图——全库总览图（Obsidian 手感）+ 单篇 Ego 图（Connected Papers 手感），
> 数据全部从已有的 UniConnection 索引派生，渲染用本地打包的 force-graph。**

## 状态：已实现，0.4.1 起在真机上确认两张图均可正常显示与交互

| 交付物 | 落点 |
|---|---|
| 数据层 `libraryGraph` / `egoGraph` | `uniConnection.ts` + `tests/uniConnectionGraph.test.ts` |
| 渲染门面 | [literature-graph.js](../apps/zotero-addon/addon/chrome/content/literature-graph.js) + vendored force-graph |
| 全库图（Graph⇄Table 切换，表格降为可折叠管理面） | `literature-explorer.js` `#collection-view` |
| 详情页图标签（同一张图，居中焦点） | `literature-explorer.js` `#detail-view` |
| 图/表筛选联动、布局坐标持久化 | `literature-explorer.js` + `views.ts` |

布局落盘在 `<dataDir>/unizero/graph/<libraryID>.json`，**刻意放在分片树之外** —— 那里的文件按 item 键入并会被
`sweep()` 在条目消失时删除，布局放进去会每次启动被清掉。坐标同时带 `GRAPH_LAYOUT_VERSION`（代码层）与
力学签名（用户层），任一不符即冷启动（§12.3、§13.3）。

0.5.0 追加：观感重做、Display/Forces 可设置项、节点右键菜单，见 §13。

**本文此后按「设计依据 + 事故记录」读。** §3 / §8 的坑与 §12 / §13 的修正是最该反复读的部分；
仍未做的事（库外 ghost 节点、2 跳、WebGL 门槛、egoGraph 的去留、分组）在 [ROADMAP.md](ROADMAP.md)。

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
| 单篇 Ego 图（Connected Papers 式） | `#detail-view` 新增 **Graph** 标签（置于 References 之前或并列） | **同一张库内图，居中在选中 Paper 上** |

> Ego 视图**不裁成 1 跳邻域**：与焦点没有直接边的论文，可能通过某篇有边的论文只隔一步，砍掉就把这层结构丢了。
> 因此详情页画的是同一张图，只是标记并居中焦点。`uniConnection.egoGraph`（1 跳查询）保留且仍有单测，
> 但当前 UI 未使用 —— 留给将来可能的「仅 1 跳」开关。

---

## 3. 交互模型（Obsidian 三段式，别让单击直接跳转）

> **实现注意（踩过的坑）**
> - force-graph **没有 `onNodeDoubleClick`**。双击靠 `onNodeClick(node, event)` 里的 `event.detail >= 2` 判定。
> - 必须 `autoPauseRedraw(false)`。节点绘制依赖 hover/选中等**外部状态**，默认的暂停重绘会在引擎停下后冻结画布，
>   表现为「所有交互都失效」。
> - 孤立节点（无边）会被斥力推到天边，`zoomToFit` 随后把真正的簇缩成一个点。需要一个弱的向心 `containForce`，
>   并让 `zoomToFit` 只框选 `degree > 0` 的节点。

- **hover**：高亮邻居子图 + 浮出预览卡——**复用现有 `.row-preview`**（xhtml 里已有样式与逻辑）。
- **单击**：选中节点 + 图重心平移到它（recenter）；与表格选中双向同步。
- **双击**：才是「打开」——等价于现在表格里 Title 链接的动作。
  - 全库图双击一个节点 → 进入该 Paper 的 `#detail-view`。
  - 「Show in Zotero」用已有 `api.selectItem(itemID)`（[literatureExplorer.ts](../apps/zotero-addon/src/ui/literatureExplorer.ts)）。
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

现有索引（见 [uniConnection.ts](../apps/zotero-addon/src/modules/uniConnection.ts) 的 `LibraryIndex`）已有 `forward` / `inverted` / `selfEdge` / `edgeOwner`，两张图**全部可直接派生，无需新抓取**。

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

数据桥是 `explorerApi()` 返回的纯对象（[literatureExplorer.ts](../apps/zotero-addon/src/ui/literatureExplorer.ts) 的 `explorerApi()`），窗口通过 `window.arguments[0].api` 拿到。**不是** `contracts.ts`（那是给 Python runtime 的 HTTP 契约，无关）。

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

---

## 12. 0.4.1 修正：渲染循环与力学参数

两条都来自 0.4 的实测反馈（主图能动 1-2 秒后卡死；节点糊成一团）。

### 12.1 force-graph 的渲染循环是单点故障

`force-graph` 的主循环最后一行才续帧，并且**全程没有 try/catch**：

```js
// node_modules/force-graph/dist/force-graph.js 的 animate()
state.onRenderFramePost && state.onRenderFramePost(ctx, globalScale);
state.tweenGroup.update();
state.animationFrameRequestId = requestAnimationFrame(animate);  // 抛异常就到不了这里
```

`onNodeHover` / `nodeCanvasObject` / `linkColor` 这些回调都是**在这个循环里同步调用**的。任何一个抛异常 → 续帧那行永远执行不到 → 画布冻在最后一帧。表现正是「能拖动一下随后完全卡死」：鼠标碰到第一个节点触发 hover 回调即死。

因此立下规矩：

1. **交给 force-graph 的每个回调都必须过 `guard()`**（`literature-graph.js`）。渲染循环的存活不能取决于 UI 回调的正确性。
2. 吞掉的异常必须**可见**：`options.onError` → 写到图的状态条（`.graph-error`）+ `console.error`，只报第一次。
3. **watchdog 兜底**：`onRenderFramePost` 累加帧计数，每 1.5s 检查；停止推进且容器可见 → `pauseAnimation()` 然后 `resumeAnimation()`。
   - **必须 pause 再 resume**：`resumeAnimation` 只在 `animationFrameRequestId` 为空时才重启，而异常留下的是上一帧的**陈旧 id**（看起来像活的），单独调用是空操作。
   - 连续复活 3 次后报一次错，避免无声地永久重启掩盖真 bug。

已在浏览器测试台验证两半：装一个会抛异常的 `onRenderFramePost`，循环每次立刻死，watchdog 每次都把它拉回来。

### 12.2 力学参数：比例错了一个量级

`check zotero-style/addon/chrome/content/dist/assets/sim.js` 是 d3-force 跑在 Web Worker 里（配一段 WASM 做 `manyBody`/`visitCollide`），里面写着 Obsidian 那四个力的默认值。对照：

| 参数 | Obsidian (sim.js) | UniZero 0.4 | 0.4.1 |
|---|---|---|---|
| linkDistance | 250 | 24 ~ 70 | 250（coupled 按权重收紧至 112） |
| repelStrength (charge) | -1000 | -118 | -1000（`distanceMax` = 12×linkDistance） |
| centerStrength | 0.1 | 0.06 | 0.09 |
| collide | 有 | **无** | 有（手写网格分桶） |

要点：

- **只有比例有意义**，绝对值无所谓——视图永远 zoom-to-fit。所谓「糊成一团」就是斥力/连线长度的比值太小，再叠加完全没有碰撞体积。
- 节点半径、线宽、箭头、字号必须**跟着一起放大**，否则 250 单位的间距配 3px 的点等于没改。
- 标签去杂改成按**屏幕像素**判定（`radius * scale < LABEL_MIN_PX` 就不画），字号用 `LABEL_PX / scale` 保持屏幕上恒定——原来的 `scale < 1.15` 阈值在放大后的坐标系里恒为真。
- **`d3Force("collide", …)` 与 `containForce` 都得手写**：force-graph 打包了 d3-force 但不重新导出 force 工厂。

测量（300 节点 / 611 边 / 12 个稠密簇的合成图，稳定后取中位数）：

| | 最近邻距离 / 节点半径 | 10 分位 | 重叠对 |
|---|---|---|---|
| 0.4 参数（无 collide） | 3.82 | 2.9 | 0 / 44850 |
| 0.4.1 | **7.49** | **6.6** | 0 / 44850 |

即每个节点周围的净空约翻倍，且在最拥挤的 10 分位仍成立。

### 12.3 布局缓存必须带版本号

存下的坐标只在**产生它们的那套力学参数的尺度下**有意义。改了 linkDistance/斥力还沿用旧坐标，等于把模拟种在我们刚要摆脱的形状里——升级后依然是一团。故 `views.ts` 加 `GRAPH_LAYOUT_VERSION`，读取时版本不符即视为冷启动。**以后每次改力学参数都要 bump。**

### 12.4 zotero-style 的 Graph 引擎：不可复用

`dist/assets/index.js`（108KB）是从 **Obsidian 里抽出来的渲染器**，不是他们自己写的：颜色键为 `fillUnresolved` / `fillAttachment`（Zotero 里没有「未解析链接」「附件节点」这种概念）、API 为 `renderer.changed()` / `testCSS()` / `interactiveEl` / `getDisplayText`、CSS 类 `.graph-view-container`——全是 Obsidian 的内部形状。仓库标 AGPL 也无权替 Obsidian 重新授权，**不要 vendor，不要参考实现**。

可以参考的只有两样，都已吸收进本节：`sim.js` 里的**力学参数取值**（数值是事实，非表达），以及架构走向——力学放 Worker、渲染用 PixiJS/WebGL。后者是**上千节点卡帧之后**才走的路，见 §11。

---

## 13. 0.5.0：观感、可设置性、节点菜单

需求方的反馈是「不卡，但想要 Obsidian 那样的美观」。**渲染后端不产生审美**——这一节做的全部是 2D 绘制层面的取舍，没有换渲染器（WebGL 的门槛仍见 §11）。

### 13.1 视觉语言：状态用填充色说，不用描边环

| | 0.4.1 | 0.5.0 | 理由 |
|---|---|---|---|
| 节点填充 | 年份连续色阶（钢蓝→橙） | **单一中性色**，年份改为可选 | 满屏连续色阶在一眼扫过时读作噪声；Obsidian 的颜色键本身就是离散的（`fill`/`fillHighlight`/`fillFocused`），没有色阶 |
| 焦点/选中/hover | 画 6~8px 描边环 | **换填充色** | 半径 8~40 的节点上 8px 环几乎和本体一样粗，稠密板面变成一片靶心 |
| Markdown 标记 | 4px 绿环 | **1.5 屏幕像素**发丝环 | 这是唯一值得全局扫视的状态，保留但不参与竞争 |
| coupled 连线 | 宽至 **10px**、alpha 至 0.5 | 宽至 **1.8px**、alpha 至 0.3 | 见下 |
| cites 连线 | 2px / alpha 0.22 | 1px / alpha 0.18 | 同上 |
| 箭头 | 恒 9px | 4px，**可关** | 9px 箭头配 1px 线不成比例 |
| link 粒子 | 宽 5 | 宽 2 | |
| 标签 | 阈值**硬切换** | 5px 起在 5 屏幕像素内**连续淡入** | 一屏文字同时出现是缩放显得生硬的主因 |

**连线宽度是屏幕像素，不是模拟单位。** force-graph 内部是 `lineWidth = width / globalScale`，所以 `10` 就是实打实的 10px。这是「糊」的第二个来源，与 §12.2 的力学比例是两回事：力学负责节点之间的距离，连线宽度负责节点是否被自己的边盖住。

实测（300 节点 / 711 边 / 12 簇，**同一份收敛后的布局**上只换绘制函数）：旧参数下每个簇是一团蓝色缎带、节点不可见；新参数下节点清晰可辨，耦合结构退为背景网。布局本身未变（最近邻距离中位数 5.83 倍半径，10 分位 3.26，重叠 0/44850）。

### 13.2 可设置项

`literature-graph.js` 的 `SETTINGS_DEFAULTS` 是唯一真相，`SETTINGS_LIMITS` + `sanitizeSettings()` 负责清洗（`null`/`undefined`/`""` 回落默认值——注意 `Number(null) === 0`，不先判空会把「缺失」变成合法的 0）。

- **Display**：`arrows`（开关）、`textFade`（标签淡入阈值，屏幕像素）、`nodeSize`（倍率）、`linkThickness`（倍率）、`colourBy`（`none` / `year`）。
- **Forces**：`centerForce`、`repelForce`、`linkForce`、`linkDistance`。

`applySettings()` 分两类处理：显示项每帧被绘制回调读取，**赋值即生效**；力学项必须重装力并 `d3ReheatSimulation()`，否则图保持旧数值产生的形状。**`nodeSize` 归在力学一侧**——碰撞力在 `initialize` 时缓存了每个节点的半径，节点大小恰好改的就是它。

`linkForce` 保持 d3 自身 `1/min(degree)` 的形状再乘倍率，所以滑块读作「比正常强多少」，且 hub 不会把整个邻域拽成一团。

设置存于 `<dataDir>/unizero/graph/settings.json`，**不分库**——它描述用户想怎么看图，与某个库的内容无关。

### 13.3 布局缓存改用力学签名

§12.3 立的规矩是「改力学参数要 bump `GRAPH_LAYOUT_VERSION`」。参数一旦交给用户，这条就不够了：**同一份代码下不同用户的力学各不相同**。因此布局文件同时记录 `forceSignature()`（`linkDistance|repelForce|centerForce|linkForce`），读取时签名不符即视为冷启动。

`GRAPH_LAYOUT_VERSION` 仍然保留，管的是**代码层面**改变坐标含义的情形（例如改了碰撞体积或半径公式）；签名管的是**用户层面**。两者都不符即丢弃。

### 13.4 节点右键菜单

`onNodeRightClick` 把节点和 MouseEvent 一起交给 explorer（右键**既不选中也不打开**，当前选中保持不动），容器上另挂一个 `contextmenu` 的 `preventDefault`。菜单项：打开详情页 / 在 Zotero 中显示 / 打开 PDF / 生成 Markdown（已有则改为「在 Obsidian 中打开」）/ 抓取 References / 抓取 Citations。

除两项外全部复用既有 api（`convertItem`、`loadRelation`、`selectItem`）。新增：

- `openPdf`：走 `ZoteroPane.viewAttachment`，由 Zotero 自己处理阅读器偏好与文件缺失。
- `openMarkdown`：取 Markdown 附件的绝对路径 → `obsidian://open?path=<encoded>`。**Obsidian 用绝对路径自行匹配 vault，因此不需要 vault 名**；文件不在任何 vault 里是 Obsidian 该报的错，这边无从预判。

改变状态的操作把 api 返回的最新 paper 合并回表格并重建图——两个界面不能有一个还在描述点击之前的状态。
