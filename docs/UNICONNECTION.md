# UniConnection — 设计与施工方案

> 交接文档（中文）。本文自包含，不依赖任何对话上下文。
> 一句话：**新建一个纯派生层 `UniConnection`，用全库每篇论文已缓存的 References 建一个反向索引，
> 让 Literature Explorer 的 `Relation` 面板从中只读投影；未来的关系图谱都挂在它上面。**

## 状态：Phase 1–4 全部已实现

| 阶段 | 落点 |
|---|---|
| Phase 1 内存索引 | [uniConnection.ts](../apps/zotero-addon/src/modules/uniConnection.ts) |
| Phase 2 增量维护 + references 补齐 | [uniConnectionSync.ts](../apps/zotero-addon/src/modules/uniConnectionSync.ts) |
| Phase 3 Relation 面板 | `views.ts` 生产端 + `literature-explorer.js` 详情页标签 |
| Phase 4 图视图 | [UNICONNECTION_GRAPH.md](UNICONNECTION_GRAPH.md) |
| 单测 | `apps/zotero-addon/tests/uniConnection*.test.ts`（`npm test`） |

**本文此后按「设计依据」读，不按「待办清单」读。** 真正仍未做的事在 [ROADMAP.md](ROADMAP.md)；
既成行为的权威描述在 [ARCHITECTURE.md](ARCHITECTURE.md) 的「Derived relations index」一节。
§7 的约束清单仍然全部有效，是本文最该被反复读的部分。

---

## 1. 背景与动机

Literature Explorer 现在有 `References` 和 `Citations` 两个面板：

- **References**（正向，A → B、C、D…）：每篇论文引用了谁。有界（通常 20–100 条），已被三源联合抓取并缓存。
- **Citations**（反向，X → A、Y → A…）：谁引用了这篇。**无界**（热门论文可达数千），一次只拉 50 条，价值被严重低估，全量拉又浪费。

我们不打算靠“把 Citations 拉全”来做关联。真正要做关联（Related Papers / Connected Papers 那种）时，
需要的不是某一篇的几千条 citation，而是**库内的边**——这个数量受库大小限制，是有界、纯本地、可精确计算的。

因此引入第三个概念 **Relation**，并用一个独立模块 `UniConnection` 承载图计算。

---

## 2. 最终决策（结论）

1. **三面板模型：References / Relation / Citation**
   - `References`：正向边，唯一真相来源，已有。
   - `Relation`（新增）：库内反向边——**库中哪些论文的 References 提到了本篇**。纯本地、有界、精确。
     未来还叠加：S2 Related Papers 推荐、手动“连线”。
   - `Citation`：退化为**展示用便捷功能**，只缓存一部分（Recent / High-influential 的 Top-N），
     **不承担知识库职责**。不追求拉全。

2. **`UniConnection` 是纯派生层，拥有图；`Relation` 面板只读投影。**
   - UniConnection **不负责抓取**。抓 references 仍是 `referencesApi.ts` 的职责。
   - UniConnection 只**消费**已有的 `References-Resolved-v4` 分片缓存，产出图。
   - 图可丢弃、可重建、可测试；真相永远是 per-item References 缓存。

3. **核心原语是一个反向索引，一个索引同时喂两种查询。**
   ```
   InvertedIndex: Map<EdgeKey, Set<ScopedItemKey>>
                  // 某条边（被引论文的身份）出现在“哪些库内论文”的 references 里
   ```
   - `Relation` 面板（库内谁引用了 P）：`index.get(edgeOf(P))`。
   - 文献耦合（A、B 有多像）：任意边 e，若 `|index.get(e)| ≥ 2`，则其中每对论文共享参考 +1。

4. **不写回。** 不把反向边数据写进被引论文的分片。反向边是可推导的派生物，不是独立真相；
   写回会导致双份真相 + 删除时的清理地狱。反向关系只存在于 UniConnection 的派生索引里。

5. **elision 兜底：先榨干 API 三源，PDF 抽取延后。**
   - references 侧已是 **OpenAlex + Crossref + Semantic Scholar 三源 union**（`referencesApi.ts` / `mergeRelations.ts`）。
   - **Crossref 是 elision 的克星**：被 S2 elide 的出版商（Wiley/Elsevier…）通常直接把 reference deposit 进 Crossref。
   - 真正三源全空的残余集很小（无 DOI，或对所有聚合器都不 deposit）。
   - **PDF 抽取（`services/paper-runtime` 里 commit `31abdf8` 退役的生产端）暂不复活**，原因见 §7 的“哑边”约束：
     PDF 抽出来的是字符串不是 DOI，对图几乎无贡献。**先测量残余比例再决定**（见 §9）。

---

## 3. 现有可复用的原语（带文件位置）

实现者应优先复用以下已存在的东西，不要重造：

| 能力 | 位置 | 说明 |
|---|---|---|
| 稳定边身份 `edgeIdentity(info)` | `apps/zotero-addon/src/modules/edgeIdentity.ts:31` | 返回 `doi:…` / `arxiv:…` / `s2:…` / `undefined`。**这就是 EdgeKey。** |
| reference 条目已打 `edge` 戳 | `edgeIdentity.ts:61` `forPersistence(entries, producedBy)` | 缓存里每条 reference 都带 `edge` 和 `producedBy`，读出来直接用。 |
| 每篇的 References 缓存 | `literatureCache.ts` `CACHE_KEY_REFERENCES = "References-Resolved-v4"` | 见 §4 形状。 |
| 每篇的 Citations 缓存 | `literatureCache.ts` `CACHE_KEY_CITATIONS = "Citations-v4"` | Relation 不用它；仅供 Citation 面板。 |
| 分片缓存读写 | `apps/zotero-addon/src/modules/localStorage.ts` | `await load(item)` 后 `get(item, key)` 同步；`set(item, key, value)` 异步。resident LRU=32（`RESIDENT_SHARDS`）。 |
| 全库分片直读（绕过 LRU） | `localStorage.ts` 的 `summary()` | 批量 build 时应仿此**直接读分片文件**，避免 LRU 抖动（见 §7）。 |
| mtime = per-item dirty marker | `localStorage.ts` 顶部注释 | 增量对账的钩子：只重扫 mtime 变过的分片。 |
| 库内成员解析 | `literatureRelations.ts` `libraryMembershipIndex` / `resolveLibraryMembership` | 已 memoize（10s TTL），`invalidateLibraryMembership()` 可失效。 |
| 从 Zotero item 取标识 | `apps/zotero-addon/src/modules/itemIdentifiers.ts` `readItemPaperIdentifiers(item)` | 返回 `{ doi, semanticScholarPaperId, arxiv? }`，用来算本篇的 self-edge。 |
| 三源 references 抓取 | `referencesApi.ts:282` `fetchReferencesByIdentifiers` | 已有；UniConnection 不改它，只在“缓存缺失时触发它”。 |

**Notifier observer 已存在**：`uniConnectionSync.register()` 在 `literature.relations` 特性的
`onWindowLoad` 里注册，`onShutdown` / `onAppShutdown` 注销（`src/core/features.ts`）。
新增其它 observer 时沿用这条对称路径，不要另起生命周期。

---

## 4. 数据模型

### 4.1 缓存记录形状（只读，勿改）

`References-Resolved-v4` → `ReferencesCache`（`literatureCache.ts`）：
```ts
interface ReferencesCache {
  savedAt: number;
  source: string;                       // "Combined" | "OpenAlex" | ...
  doi: string;
  semanticScholarPaperId?: string;
  resolved: boolean;
  references: ItemBaseInfo[];           // 每条带 edge（可能为 undefined）与 producedBy
  perSource?: RelationSourceResult[];
}
```
每条 `references[i]` 的关键字段：`identifiers`（DOI/arXiv/paperID）、`edge`（= edgeIdentity 结果，**可能 undefined**）、`title`、`producedBy`。

### 4.2 UniConnection 内部结构（派生，可重建）

```ts
type EdgeKey = string;         // "doi:10.x/y" | "arxiv:2401.00001" | "s2:abc"
type ScopedItemKey = string;   // `${libraryID}:${itemKey}`，与 libraryItemIdentity 一致

// 反向：某条边出现在哪些库内论文的 references 里
inverted:  Map<EdgeKey, Set<ScopedItemKey>>;
// 正向：某库内论文自己的 reference 边集合（供耦合计算）
forward:   Map<ScopedItemKey, Set<EdgeKey>>;
// 库内论文 <-> 它自己的身份边（把 item 映射到边，反查库内被引者）
selfEdge:  Map<ScopedItemKey, EdgeKey>;
edgeOwner: Map<EdgeKey, ScopedItemKey>;   // selfEdge 的反向，仅库内端点
```

> `forward` 与 `inverted` 都来自同一份 per-item References 缓存；`selfEdge/edgeOwner` 来自各 item 自身标识。

---

## 5. 核心算法

### 5.1 消化一篇论文（ingest）

对库内每篇论文 P（`scoped = ${libraryID}:${key}`）：
1. `self = edgeOf(P)`：用 `readItemPaperIdentifiers(P)` 构造 identifiers，走 `edgeIdentity`。
   若非空，写入 `selfEdge[scoped]=self`、`edgeOwner[self]=scoped`。
2. 读 P 的 `References-Resolved-v4`。对每条 reference r：
   - `e = r.edge`（缓存已算好）。**若 `e` 为空则跳过**（哑边，见 §7）。
   - `forward[scoped].add(e)`；`inverted[e].add(scoped)`。

### 5.2 撤销一篇论文（retract）——删除/更新前调用

用 `forward[scoped]` 找到该篇贡献过的所有边，从每个 `inverted[e]` 里删掉 `scoped`；
清理 `forward[scoped]`、`selfEdge[scoped]` 及其 `edgeOwner` 反向项。更新 = retract + ingest。

### 5.3 查询 A：Relation（库内谁引用了 P）

```
relationsOf(P):
  self = selfEdge[scoped(P)]  // 或现算 edgeOf(P)
  if !self: return []
  return [...inverted.get(self) ?? []].filter(k => k !== scoped(P))
         // 每个 k 是“references 里提到了 P”的库内论文
```

### 5.4 查询 B：文献耦合（与 P 共享参考最多的库内论文）

```
coupledWith(P, limit):
  tally = Map<ScopedItemKey, number>()
  for e in forward[scoped(P)]:
    for k in inverted.get(e) ?? []:
      if k !== scoped(P): tally[k] += 1
  return topN(tally, limit)   // 值 = 共享参考数
```

> 两个查询共用同一个 `inverted`。这是本设计的核心杠杆。

---

## 6. 施工阶段

### Phase 1 — 纯内存 UniConnection ✅ 已实现
- 新建 `apps/zotero-addon/src/modules/uniConnection.ts`，实现 §4.2 结构 + §5 算法。
- `build(libraryID)`：遍历该库所有常规 item，**直接读分片文件**（仿 `localStorage.ts:199` `summary()`，
  不要走 `load`/`get` 的 LRU，避免全库扫描抖 resident 缓存），消化每篇。
- 暴露 `relationsOf(item)` 与 `coupledWith(item)`。
- **不落盘、不挂 notifier。** 首次调用时 lazy build，会话内常驻。
- 验收：对若干已缓存 references 的论文，两个查询返回合理结果（见 §9）。

### Phase 2 — 增量维护 ✅ 已实现（落盘水位线**未做**，见下）
- 注册 `Zotero.Notifier` observer（`add`/`modify`/`delete`/`trash`，type `item`），插件卸载时注销。
  - add/modify：若该 item 有 references 缓存则 `retract` 后 `ingest`；无缓存则按策略触发抓取（见下）。
  - delete/trash：`retract`。
  - 每次变更后调用 `invalidateLibraryMembership(libraryID)`。
- **主动补齐 references**：为没有 references 缓存的 item，用节流队列调
  `fetchReferencesByIdentifiers`（遵守 S2 ~1 rps；OpenAlex/Crossref 更宽松），写回 `References-Resolved-v4`，再 ingest。
  这一步是“加入文章 → 缓存 References → 建 connection”的落点。
- **可选落盘（未实现，仍是内存 lazy build）**：`inverted`/`forward` 序列化为单个
  `uniconnection/<libraryID>.json` + 一个“已消化到 mtime = T”的水位线；重启后只对账
  mtime > T 的分片（`localStorage.ts:18` 的钩子）。
  当前索引每次会话首次查询时惰性重建；唯一落盘的是**图布局坐标**（`graph/<libraryID>.json`），
  与本条无关。库大到重建明显卡顿时再做。

### Phase 3 — Relation 面板（Explorer 只读投影）✅ 已实现
- 在 Literature Explorer 增加 `Relation` 面板，数据来自 `uniConnection.relationsOf(item)`（+ 可选 `coupledWith`）。
- 复用现有面板的行渲染 / 库内成员标记 / 筛选。
- Relation 行本身都是库内 item，可直接跳转。

### Phase 4 — 图与更多边类型 ✅ 图已实现（见 [UNICONNECTION_GRAPH.md](UNICONNECTION_GRAPH.md)）
- 边类型扩展：`reference`（已有）、`coupling`（派生）、`recommendation`（S2 Related Papers）、
  `manual`（**用 Zotero 原生 related items / `dc:relation`，不要自建**，跟随同步）。
- 图可视化：obsidian graph view 式 / Connected Papers 式 / 项目特定图，均为 UniConnection 的只读消费者。

### 延后 / 门槛项 — PDF Reference Extraction 复活
- 仅在 §9 测得“API 三源全空”的残余比例**显著**时才考虑。
- 复活的是 `services/paper-runtime`（PDF→MD）里 commit `31abdf8` 退役的**生产端**；
  消费端 `readZoMinerReferences`（`zomReferences.ts`，被 `views.ts` 调用）仍在，插座现成。
- 即便复活，PDF 抽的是字符串，需 `resolve.ts` 匹配回 DOI 才能进图，且有误匹配风险（见 §7）。

---

## 7. 关键约束与坑（必须遵守）

1. **哑边（anonymous edge）不能当端点。**
   `edgeIdentity` 对没有 DOI/arXiv/paperID 的条目返回 `undefined`（`edgeIdentity.ts:48`）。
   `r.edge` 为空的 reference **必须跳过**，不能用标题拼一个 key——那会把不同论文悄悄合并。
   → PDF 抽取产出的多为字符串（哑边），这就是它“对图几乎无贡献”的根因。

2. **索引要建在“所有”边上，不能只保留库内成员的边。**
   A、B 可能通过一条“本身不在库里的共享参考”耦合。库内过滤只在**查询时**施加。
   `inverted` 的 key 空间是全体 reference 边；`edgeOwner` 只记录恰好在库内的端点。

3. **批量 build 走分片直读，不走 LRU。**
   `localStorage` resident 只有 32（`localStorage.ts:48`）。全库 `load`/`get` 会疯狂淘汰。
   build 时仿 `summary()` 直接 `IOUtils.readUTF8` 遍历分片。

4. **读缓存前必须 `await load(item)`。** 单篇路径（如 Relation 面板现算 self-edge）用到 `get` 时先 load。

5. **多库隔离。** ScopedItemKey = `${libraryID}:${itemKey}`（对齐 `libraryItemIdentity`）。
   分片树本就按 libraryID 分目录；索引、落盘、notifier 都按库隔离。群组库/同步会异步加 item。

6. **身份变更。** item 的 DOI 事后被补全会改变它的 self-edge。modify 事件里 retract+ingest 已覆盖；
   落盘方案要保证水位线对账能捕捉到（mtime 会更新）。

7. **Relation 完整度受 references 覆盖率限制。** publisher elision + 无 DOI 的论文是图里的“哑节点”。
   这是真正的上限，不是机制问题。§9 的测量就是量这个。

---

## 8. 建议的模块接口（TS 骨架）

> 已实现，**以代码为准**：真实签名多数是 `async`，另有 `retractItemID` 与按库/参数记忆化的
> `libraryGraph`。详情页焦点图由 Views 在完整图上标记焦点，不在 UniConnection 维护第二套查询。
> 下面这份骨架保留下来只为说明「一个索引喂两种查询」的意图。

`apps/zotero-addon/src/modules/uniConnection.ts`
```ts
export type EdgeKey = string;
export type ScopedItemKey = string;

export interface RelationHit {
  scopedKey: ScopedItemKey;   // 引用了本篇的库内论文
  edge?: EdgeKey;
}
export interface CouplingHit {
  scopedKey: ScopedItemKey;
  shared: number;             // 共享参考数
}

export class UniConnection {
  /** 全库扫描分片，重建内存索引（Phase 1）。分片直读，勿走 LRU。 */
  async build(libraryID: number): Promise<void>;

  /** 消化/撤销单篇（Phase 2 notifier 调用）。 */
  ingestItem(item: Zotero.Item): Promise<void>;   // 内部：retract 旧的再加新的
  retract(scopedKey: ScopedItemKey): void;

  /** 查询 A：库内谁引用了本篇。 */
  relationsOf(item: Zotero.Item): RelationHit[];

  /** 查询 B：与本篇共享参考最多的库内论文。 */
  coupledWith(item: Zotero.Item, limit?: number): CouplingHit[];

  /** 诊断：节点数、边数、哑边跳过数、覆盖率——供 UniZeroDebug 与 §9 测量。 */
  stats(libraryID: number): { items: number; edges: number; skippedAnon: number; itemsWithRefs: number };
}
```
- `edgeOf(item)`：`edgeIdentity({ identifiers: fromReadItemPaperIdentifiers(item) })` 的小封装（复用，不要重写归一化）。
- 单例即可；按 libraryID 维护多份索引，或索引内用 ScopedItemKey 自然隔离。

---

## 9. 验证与测量

**功能验收（Phase 1）**
- 选一组已缓存 references、且彼此有引用/共享参考的库内论文，人工核对：
  - `relationsOf(P)` 命中确实在其 references 里含 P 的论文；
  - `coupledWith(P)` 的 shared 数与手工数一致。
- 反向一致性：若 A 的 references 含 B，则 `relationsOf(B)` 必含 A。

**残余测量（决定 PDF 抽取是否复活）**
- 全库跑一遍 `fetchReferencesByIdentifiers`，用 `referencesDiagnostics` 统计：
  - 三源全空（`chosen === "none"`）的论文占比；
  - 其中“有 PDF 附件”的占比（PDF 抽取只对这部分有意义）。
- 只有当这两个比例都**不可忽略**时，才把 PDF 抽取复活排进计划。

**性能**
- Phase 1 build 对典型库（数百–数千篇）应在数秒内；若过慢，优先落盘水位线（Phase 2 可选项）。

---

## 10. 明确不做 / 延后

- ❌ 不把反向边写回被引论文的分片（§2.4）。
- ❌ 不追求把 Citations 拉全；Citation 面板只留 Recent / High-influential Top-N。
- ❌ 不用标题给哑边造 key。
- ⏳ PDF Reference Extraction 复活：以 §9 测量为门槛。
- ⏳ 索引落盘水位线：仍未做，靠内存 lazy build。
- ✅ 图可视化：已实现（[UNICONNECTION_GRAPH.md](UNICONNECTION_GRAPH.md)）。
- ⏳ S2 推荐 / 手动连线：仍未做，均为 UniConnection 只读消费者；手动连线用 Zotero 原生 related items。
