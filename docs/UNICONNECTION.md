# UniConnection — 派生关系索引与图视图

> 中文设计文档，自包含。
> 一句话：**一个纯派生层，用全库每篇论文已缓存的 References 建反向索引；Relation 面板、
> Board hover 关系提示和单篇图都是它的只读消费者。**

## 状态

| 部分 | 状态 | 落点 |
|---|---|---|
| 内存索引 + 增量维护 | 在用，并且是 Board 关系提示的底座 | `uniConnection.ts` / `uniConnectionSync.ts` |
| Relation 面板 | 在用 | `views.ts` 生产端 + 详情页标签 |
| Board hover 关系提示 | 在用 | `boardConnections()` → `boardRelationHints` |
| 单篇 Graph 标签 | 在用 | `focusedGraph` + `literature-graph.js` |
| 全库总览图、管理表 | **已删除**，见 §4 | — |

现行行为的权威描述在 [ARCHITECTURE.md](ARCHITECTURE.md)，未做的事在 [ROADMAP.md](ROADMAP.md)。
本文按「设计依据 + 事故记录」读，不按待办清单读；§3 的约束是最该反复读的部分。

## 1. 为什么是纯派生层

References（A → B、C…）有界——通常 20–100 条，且已被 OpenAlex + Crossref + Semantic Scholar
三源联合抓取并缓存。Citations（谁引用了 A）无界，热门论文可达数千。

做关联需要的不是某一篇的几千条 citation，而是**库内的边**：数量受库大小限制，有界、纯本地、
可精确计算。由此三条：

1. UniConnection **不抓取**，只消费已有的 `References-Resolved-v4` 分片缓存。抓取仍是
   `referencesApi.ts` 的职责。
2. 图可丢弃、可重建、可在没有 Zotero 的情况下单测；真相永远是 per-item References 缓存。
3. **不写回**被引论文的分片。反向边是可推导的派生物，不是独立真相；写回会造成双份真相，
   以及删除时的清理地狱。

## 2. 结构与查询

```ts
type EdgeKey = string;       // "doi:…" | "arxiv:…" | "s2:…"，由 edgeIdentity() 产出
type ScopedItemKey = string; // `${libraryID}:${itemKey}`

inverted:  Map<EdgeKey, Set<ScopedItemKey>>;   // 某条边出现在哪些库内论文的 references 里
forward:   Map<ScopedItemKey, Set<EdgeKey>>;   // 某库内论文自己的 reference 边集合
selfEdge:  Map<ScopedItemKey, EdgeKey>;        // 库内论文 → 它自己的身份边
edgeOwner: Map<EdgeKey, ScopedItemKey>;        // selfEdge 的反向，仅库内端点
```

**一个 `inverted` 同时喂两种查询**，这是本设计的核心杠杆：

- `relationsOf(P)`——库内谁引用了 P：读 `inverted[selfEdge[P]]`。
- `coupledWith(P)`——与 P 共享参考最多的库内论文：走 `forward[P]` 的每条边，在 `inverted` 里计票。

`libraryGraph(libraryID, options)` 从同一批结构派生全库拓扑，按库 + 有效参数记忆化；
build / ingest / retract / trash / delete 清除对应库的缓存。`boardConnections()` 是同一批
结构的第三个消费者，把边投影到调用方给定的 Paper 集合上。

拓扑只含 `id` / `itemKey` / `degree` / `isCenter`，**不含任何 Zotero 字段**——title、year、
citations 由 `views.getLiteratureGraph` 事后富化，索引层因此保持宿主无关、可单测。

## 3. 关键约束（必须遵守）

1. **哑边不能当端点。** `edgeIdentity` 对没有 DOI/arXiv/paperID 的条目返回 `undefined`，
   这样的 reference 必须跳过——用标题拼一个 key 会把不同论文悄悄合并。PDF 抽取产出的多是
   哑边，这就是它对图几乎无贡献的根因。
2. **索引建在所有边上，不只库内成员的边。** A、B 可能通过一条本身不在库里的共享参考耦合。
   库内过滤只在**查询时**施加。
3. **批量 build 走分片直读，不走 LRU。** `localStorage` 的 resident 只有 32；全库
   `load`/`get` 会把交互工作集全部淘汰。仿 `summary()` 直接遍历分片文件。
4. **单篇路径读缓存前必须 `await load(item)`。**
5. **多库隔离。** ScopedItemKey 一律带 libraryID；群组库与同步会异步加 item。
6. **身份变更走 retract + ingest。** item 事后补上 DOI 会改变它的 self-edge。
7. **耦合边要有超级 hub 上限。** 人人都引的方法论论文会拉出 O(n²) 的稠密团，既慢又无信息量；
   `|inverted[e]| > COUPLING_HUB_CAP`（200）直接跳过。
8. **Relation 完整度受 references 覆盖率限制。** publisher elision 和无 DOI 的论文是图里的
   哑节点。这是真正的上限，不是机制问题。

## 4. 图视图：全库图已删除

Home 的主视图改为三栏 Project View 之后，全库总览图和管理表先被隐藏，随后连同它们专属的
状态刷新、表格快捷操作和筛选一起删除。保留下来的是：

- **Board hover 关系提示**——`boardConnections` 把 UniConnection 的边投影到当前 Board 的
  Paper 集合上，画成临时 overlay，**绝不写入 manual edge 文档**；
- **单篇 Graph 标签**——`focusedGraph` 取同一张完整库内图并标记居中焦点。它刻意不裁成 1 跳
  邻域：与焦点没有直接边的论文可能只隔一步，砍掉就把这层结构丢了。

下面几条是实机事故换来的。它们对现存的 Graph 标签仍然全部有效，日后若要重建全库图，
先读这一节。

### 4.1 force-graph 的渲染循环是单点故障

主循环最后一行才续帧，且全程没有 try/catch：

```js
state.animationFrameRequestId = requestAnimationFrame(animate);  // 抛异常就到不了这里
```

`onNodeHover` / `nodeCanvasObject` / `linkColor` 都在这个循环里**同步**调用。任何一个抛异常，
续帧那行就永远执行不到，画布冻在最后一帧——表现正是「能拖一下随后完全卡死」。因此：

1. 交给 force-graph 的每个回调都必须过 `guard()`。渲染循环的存活不能取决于 UI 回调的正确性。
2. 吞掉的异常必须**可见**：`onError` → 图的状态条 + `console.error`，只报第一次。
3. watchdog 兜底：`onRenderFramePost` 累加帧计数，停止推进且容器可见时
   **`pauseAnimation()` 再 `resumeAnimation()`**——`resumeAnimation` 只在
   `animationFrameRequestId` 为空时才重启，而异常留下的是上一帧的陈旧 id，单独调用是空操作。
4. `autoPauseRedraw(false)`：节点绘制依赖 hover/选中等外部状态，默认的暂停重绘会在引擎停下后
   冻结画布，表现为「所有交互都失效」。
5. force-graph **没有 `onNodeDoubleClick`**；双击靠 `onNodeClick(node, event)` 里的
   `event.detail >= 2` 判定。

### 4.2 尺度：只有比例有意义

视图永远 zoom-to-fit，绝对值无所谓，「糊成一团」来自比例。这里有两个互相独立的尺度问题：

- **力学比例**决定节点之间的距离：linkDistance 250 / repelForce 1000 / centerForce 0.09，
  并且必须有碰撞体积。`d3Force("collide", …)` 和向心 `containForce` 都得手写——force-graph
  打包了 d3-force 但不重新导出 force 工厂。孤立节点会被斥力推到天边，`zoomToFit` 因此只框
  `degree > 0` 的节点。
- **连线宽度**决定节点是否被自己的边盖住。force-graph 内部是 `lineWidth = width / globalScale`，
  所以参数就是实打实的屏幕像素：coupled ≤1.8px / alpha ≤0.3，cites 1px / alpha 0.18。
- 标签去杂按**屏幕像素**判定（`radius * scale` 低于阈值就不画），字号用 `LABEL_PX / scale`
  保持屏幕上恒定。按模拟坐标系设阈值在放大后的坐标系里恒为真。

**`nodeSize` 必须是纯屏幕属性，不能进入力学。** 碰撞力在 `initialize` 时缓存半径，把
nodeSize 归到力学一侧的结果是：半径放大 → 碰撞把整个布局按同一比例撑大 → zoom-to-fit 又
除回去，滑块几乎是空操作，只留下「节点相对没有跟着放大的 linkDistance 变粗」这个副作用。
所以 `radius()` 是**布局半径**（只有力学看它），`drawRadius() = radius() × nodeSize` 供绘制
与命中区域使用。

`SETTINGS_DEFAULTS` 是这些值的唯一真相，`SETTINGS_LIMITS` + `sanitizeSettings()` 负责清洗
——注意 `Number(null) === 0`，不先判空会把「缺失」变成合法的 0。

### 4.3 布局坐标带两道门

坐标只在**产生它们的那套力学参数的尺度下**有意义，因此布局文件同时记录：

- `GRAPH_LAYOUT_VERSION`——**代码层**改变了坐标含义时手动 bump（例如改了碰撞体积或半径公式）；
- `forceSignature()`——**用户层**，因为力学参数已交给用户，同一份代码下各人不同。

任一不符即冷启动。读写还会丢弃非有限坐标和不属于当前 `${libraryID}:` 命名空间的节点，
同库写入串行。布局落盘在 `<dataDir>/unizero/graph/<libraryID>.json`，**刻意放在分片树之外**
——分片按 item 键入并会被 `sweep()` 在条目消失时删除，布局放进去会每次启动被清掉。
设置存于 `graph/settings.json` 且**不分库**：它描述用户想怎么看图，与某个库的内容无关。

### 4.4 不要 vendor Obsidian 的图代码

zotero-style 的 `dist/assets/index.js` 是从 Obsidian 里抽出来的渲染器，不是他们自己写的：
颜色键 `fillUnresolved` / `fillAttachment`、API `renderer.changed()`、CSS 类
`.graph-view-container` 全是 Obsidian 的内部形状。Obsidian 应用代码闭源、禁止再分发，
仓库标 AGPL 也无权替 Obsidian 重新授权。可以参考的只有力学参数取值——数值是事实，不是表达。

## 5. 明确不做 / 延后

- ❌ 把反向边写回被引论文的分片。
- ❌ 追求把 Citations 拉全；Citation 面板只留 Recent / High-influential Top-N。
- ❌ 用标题给哑边造 key。
- ⏳ 索引落盘水位线：仍未做，每次会话首次查询时惰性重建。库大到重建明显卡顿时再做，
  钩子是 `localStorage.ts` 的 per-item mtime。
- ⏳ S2 推荐边、库外 ghost 发现节点、WebGL 渲染器：见 [ROADMAP.md](ROADMAP.md)。
  手工连线已由 Board 的 manual edge 文档承担，不再计划走 Zotero related items。
