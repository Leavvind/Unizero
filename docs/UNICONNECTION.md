# UniConnection — 派生关系索引

> 中文设计文档。**一个纯派生层：用全库每篇论文已缓存的 References 建反向索引。**
> Relation 面板（Unizero Home 与条目面板）和 Bridge 详情都是只读消费者。

## 状态

| 部分 | 状态 | 落点 |
|---|---|---|
| 内存索引 + 增量维护 | 在用 | `uniConnection.ts` / `uniConnectionSync.ts` |
| Relation 面板 / Obsidian detail | 在用 | `views.ts` + bridge / 详情页 |
| 全库总览图、管理表、单篇 Graph 标签、Board hover 提示 | **已删除** | — |

现行行为：[ARCHITECTURE.md](ARCHITECTURE.md)。未完成项：[ROADMAP.md](ROADMAP.md)。
§1 的约束最该反复读。

## 1. 关键约束（必须遵守）

1. **纯派生、不抓取、不写回。** 只消费 `References-Resolved-v4` 分片。真相永远是
   per-item References 缓存；反向边不写回被引论文的分片。
2. **哑边不能当端点。** `edgeIdentity` 对没有 DOI/arXiv/paperID 的条目返回
   `undefined`——用标题拼 key 会把不同论文悄悄合并。
3. **索引建在所有边上，不只库内成员。** 库内过滤只在查询时施加。
4. **索引不含 Zotero 字段。** 只存 ScopedItemKey 与 EdgeKey；title、year 等由
   `views` 事后从 Zotero 条目富化。
5. **批量 build 走分片直读，不走 LRU。** resident 只有 32；全库 `load` 会淘汰交互集。
6. **单篇路径读缓存前必须 `await load(item)`。**
7. **多库隔离。** ScopedItemKey 一律带 `libraryID`。
8. **身份变更走 retract + ingest。** 事后补 DOI 会改变 self-edge。
9. **Reference 写入先于关系读取。** References 刷新 await 缓存写入与 `ingestItem`
   之后 bridge 才 resolve。

## 2. 结构与查询

```ts
type EdgeKey = string;       // "doi:…" | "arxiv:…" | "s2:…"
type ScopedItemKey = string; // `${libraryID}:${itemKey}`

inverted:  Map<EdgeKey, Set<ScopedItemKey>>;
forward:   Map<ScopedItemKey, Set<EdgeKey>>;
selfEdge:  Map<ScopedItemKey, EdgeKey>;
```

一个 `inverted` 同时喂：

- `relationsOf(P)` — 库内谁引用了 P；
- `coupledWith(P)` — 与 P 共享参考最多的库内论文。

Relation 面板与 bridge 详情都是这两个查询的投影。

**为什么是 References 而不是 Citations：** References 有界且已缓存；Citations 无界。
库内关联边受库大小限制，可精确本地计算。

## 3. 明确不做

- 把反向边写回被引论文的分片。
- 用标题给哑边造 key。
- 把 Citations 拉全当作图原料。
- 未做：索引落盘水位线（库大到重建卡顿时再做）。
