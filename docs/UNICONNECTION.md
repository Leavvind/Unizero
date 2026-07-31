# UniConnection — 派生关系索引与图视图

> 中文设计文档。**一个纯派生层：用全库每篇论文已缓存的 References 建反向索引。**
> Relation 面板、Bridge 详情、Board hover 提示和单篇 Graph 都是只读消费者。

## 状态

| 部分 | 状态 | 落点 |
|---|---|---|
| 内存索引 + 增量维护 | 在用 | `uniConnection.ts` / `uniConnectionSync.ts` |
| Relation 面板 / Obsidian detail | 在用 | `views.ts` + bridge / 详情页 |
| Board hover 关系提示 | 在用（legacy Home） | `boardConnections()` |
| 单篇 Graph 标签 | 在用 | `focusedGraph` + `literature-graph.js` |
| 全库总览图、管理表 | **已删除** | — |

现行行为：[ARCHITECTURE.md](ARCHITECTURE.md)。未完成项：[ROADMAP.md](ROADMAP.md)。
§1–2 的约束最该反复读；§3 只在改 Graph 渲染时需要。

## 1. 关键约束（必须遵守）

1. **纯派生、不抓取、不写回。** 只消费 `References-Resolved-v4` 分片。真相永远是
   per-item References 缓存；反向边不写回被引论文的分片。
2. **哑边不能当端点。** `edgeIdentity` 对没有 DOI/arXiv/paperID 的条目返回
   `undefined`——用标题拼 key 会把不同论文悄悄合并。
3. **索引建在所有边上，不只库内成员。** 库内过滤只在查询时施加。
4. **拓扑不含 Zotero 字段。** 节点只有 `id` / `itemKey` / `degree` / `isCenter`；
   title、year、citations 由 `views.getLiteratureGraph` 事后富化。
5. **批量 build 走分片直读，不走 LRU。** resident 只有 32；全库 `load` 会淘汰交互集。
6. **单篇路径读缓存前必须 `await load(item)`。**
7. **多库隔离。** ScopedItemKey 一律带 `libraryID`。
8. **身份变更走 retract + ingest。** 事后补 DOI 会改变 self-edge。
9. **耦合边有超级 hub 上限。** `|inverted[e]| > COUPLING_HUB_CAP`（200）跳过。
10. **Reference 写入先于拓扑读取。** References 刷新 await 缓存写入与 `ingestItem`
    之后 bridge 才 resolve。

## 2. 结构与查询

```ts
type EdgeKey = string;       // "doi:…" | "arxiv:…" | "s2:…"
type ScopedItemKey = string; // `${libraryID}:${itemKey}`

inverted:  Map<EdgeKey, Set<ScopedItemKey>>;
forward:   Map<ScopedItemKey, Set<EdgeKey>>;
selfEdge:  Map<ScopedItemKey, EdgeKey>;
edgeOwner: Map<EdgeKey, ScopedItemKey>;
```

一个 `inverted` 同时喂：

- `relationsOf(P)` — 库内谁引用了 P；
- `coupledWith(P)` — 与 P 共享参考最多的库内论文；
- `libraryGraph` / `boardConnections` / bridge 详情 — 同一批结构的投影。

`libraryGraph` 按库 + 有效参数记忆化；build / ingest / retract / trash / delete
清除对应库缓存。

**为什么是 References 而不是 Citations：** References 有界且已缓存；Citations 无界。
库内关联边受库大小限制，可精确本地计算。

## 3. Legacy Graph 渲染陷阱

全库总览图已删；保留的是单篇 Graph 标签和（legacy Home 的）Board hover 提示。
下面是实机事故换来的规则——改 `literature-graph.js` 时必读。

### 3.1 force-graph 渲染循环是单点故障

主循环最后一行才续帧，全程无 try/catch。`onNodeHover` / `nodeCanvasObject` /
`linkColor` 同步调用；任一抛异常则画布永久冻结。因此：

1. 每个回调过 `guard()`。
2. 吞掉的异常必须可见（状态条 + `console.error`，只报第一次）。
3. watchdog：帧停止推进时 `pauseAnimation()` 再 `resumeAnimation()`（单独 resume
   在陈旧 `animationFrameRequestId` 上是空操作）。
4. `autoPauseRedraw(false)`：外部 hover 状态依赖持续重绘。
5. 无 `onNodeDoubleClick`；用 `onNodeClick` 的 `event.detail >= 2`。

### 3.2 尺度：只有比例有意义

- 力学参数与碰撞体积必须配套；孤立节点会被斥力推远，`zoomToFit` 只框 `degree > 0`。
- 连线宽度是屏幕像素（force-graph 内部 `width / globalScale`）。
- **`nodeSize` 是纯屏幕属性，不进力学。** `radius()` 供布局；`drawRadius()` 供绘制。
- `SETTINGS_DEFAULTS` / `SETTINGS_LIMITS` / `sanitizeSettings()` 是唯一真相；
  注意 `Number(null) === 0`。

### 3.3 布局坐标两道门

- `GRAPH_LAYOUT_VERSION` — 代码改变坐标含义时手动 bump；
- `forceSignature()` — 用户改力学参数时失效。

任一不符即冷启动。布局在 `<dataDir>/unizero/graph/<libraryID>.json`（分片树外）；
设置在 `graph/settings.json`（不分库）。**Board geometry 是另一套状态**，见
[LEGACY_HOME.md](LEGACY_HOME.md)。

### 3.4 不要 vendor Obsidian 的图代码

Obsidian 应用代码闭源、禁止再分发。可参考的只有力学参数取值（数值是事实）。

## 4. 明确不做

- 把反向边写回被引论文的分片。
- 用标题给哑边造 key。
- 把 Citations 拉全当作图原料。
- 未做：索引落盘水位线（库大到重建卡顿时再做）。
