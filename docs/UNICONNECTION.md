# UniConnection — 派生关系索引与引用摘句

> 中文设计约束文档。**纯派生层：用每篇论文已缓存的 References 与用户手工挑选的引用摘句
> （Excerpts）建立库内引用关系索引。** 条目面板、UniConnection full、Unizero Home 与
> bridge 都是只读消费方。

## 状态

| 部分 | 状态 | 落点 |
| --- | --- | --- |
| 内存索引 + 增量维护 | 在用 | `src/modules/uniConnection.ts`、`uniConnectionSync.ts` |
| 摘句笔记格式、写入、bridge 字段 | 在用 | `src/zotero/excerptNote*.ts`、`excerptAnnotations.ts`、`src/server/` |
| 条目面板与 full 窗口（§5.1–5.3） | 在用 | `src/ui/literatureSidebar*.ts`、`uniConnectionFull.ts` |
| Unizero Home（§5.4） | 在用 | `src/ui/unizeroHome*.ts`、`excerptPairs`、`referencesLoadedAt`、`src/zotero/uniConnectionActivity.ts` |
| bridge `relation` / Obsidian 详情 | 在用 | `src/modules/views.ts`、`src/server/` |
| 摘句排序、Obsidian 展示摘句与计数 | 未做 | [ROADMAP.md](ROADMAP.md#citation-excerpts) |

现行架构总览见 [ARCHITECTURE.md](ARCHITECTURE.md)。计划中的重做（从 Raw / Canvas 链接派生论文关系、
退役条目面板与 full 窗口）见 [UNICONNECTION_REDESIGN.md](UNICONNECTION_REDESIGN.md)；Zotero 侧尚未实现。

## 1. 关键约束

1. **纯派生、不抓取、不写回。** 只消费 `References-Resolved-v4` 分片与带
   `unizero:excerpts` 标签的子笔记（§4）；反向边绝不写回被引论文的分片或笔记。
2. **哑边不能当端点。** `edgeIdentity` 对缺少 DOI / arXiv / S2 `paperID` 的条目返回
   `undefined`（用标题拼 key 会静默合并同名异文）。摘句边两端都是库内条目，直接用
   `ScopedItemKey`。
3. **索引建在所有边上，库内过滤在查询时施加。**
4. **索引不含 Zotero 显示字段。** 只存 `ScopedItemKey` 与 `EdgeKey`（摘句例外保留用户原文快照），标题、年份由消费方在展示时富化。
5. **批量 `build` 走分片直读，绕过 32 条驻留 LRU。** 先列一次缓存目录，只读有分片的条目；分两段：条目与摘句笔记先就绪，`excerptsFrom` / `excerptsAbout` / `excerptPairs` 不等分片；`relationsOf`、`coupledWith`、`referencesLoadedAt` 等全部分片读完才返回。构建期间的条目与笔记变动同时写入构建中的索引，避免被构建结果覆盖。
6. **单篇路径读缓存前必须 `await load(item)`。**
7. **多库隔离。** `ScopedItemKey` 一律含 `libraryID`；摘句引用端与被引端必须同库。
8. **身份变更走 `retract` + `ingest`**（事后补 DOI 会改变 `selfEdge`）。
9. **写入先于读取。** References 刷新须 `await` 缓存写入与 `ingestItem` 后再返回；摘句写完立即 `ingestExcerptNote`。

## 2. 结构与查询

```ts
type EdgeKey = string;       // "doi:…" | "arxiv:…" | "s2:…"
type ScopedItemKey = string; // `${libraryID}:${itemKey}`

inverted:     Map<EdgeKey, Set<ScopedItemKey>>;
forward:      Map<ScopedItemKey, Set<EdgeKey>>;
selfEdge:     Map<ScopedItemKey, EdgeKey>;
excerptNotes: Map<number /* note itemID */, {
  citing: ScopedItemKey;
  sections: { cited: ScopedItemKey; excerpts: ExcerptRecord[] }[];
}>;
excerptedBy:  Map<ScopedItemKey /* cited */, Set<number /* note itemID */>>;
```

- `relationsOf(P)`：库内谁引用了 P（References 缓存含 P，或摘句笔记含 P 的节）。
- `coupledWith(P)`：与 P 共享参考文献最多的库内论文。
- `excerptsFrom(A)` / `excerptsAbout(B)`：A 挂在各被引文献下的句子 / 库内提到 B 的句子。
- `excerptPairs(libraryID)`：全库所有 `(citing → cited)` 摘句对，与上面两项同源。

**为什么建在 References 而不是 Citations 上：** 单篇 References 有界且已缓存，Citations 无界；库内反向引用受文库规模限制，可本地精确计算。

## 3. 明确不做

- 反向边写回分片、用标题拼边 key、拉全量 Citations 建图。
- 跨库摘句，或直接对库外论文挂摘句（须先点 `+` 加入同库）。
- 已退役的全库图谱、单篇 Graph 标签与旧 Board 视图（不恢复）；索引落盘待大库实测卡顿再议。

## 4. 引用摘句（Excerpts）

### 4.1 定位与前置条件

摘句是**用户亲手挑选的内容**（读 A 的 PDF 时把提到 B 的批注挂到 B 名下），不能存进会被刷新覆盖的 References 缓存。被引方 B 必须是与 A 同库的常规条目：库外条目先用行内 `+` 入库；不在 provider References 里的同库条目通过顶部统一搜索关联。

### 4.2 存储格式（A 的子笔记）

每篇引用方 A 至多一条带 `unizero:excerpts` 标签的子笔记（按标签认所有权，不靠标题），随 Zotero 同步，卸载插件后仍可读可跳；被引方 B 永远只读：

```html
<div data-schema-version="9">
<h1>Cited passages</h1>
<h2><a href="zotero://select/library/items/B_KEY">Dick-Nielsen (2014)</a></h2>
<p><span class="highlight" data-annotation="%7B…annotationKey…%7D">“Following Dick-Nielsen (2014), …”</span>
 <span class="citation" data-citation="%7B…%7D">(<span class="citation-item">A, 2020, p. 7</span>)</span></p>
</div>
```

- **节身份 = `<h2>` 内 `zotero://select/…/items/KEY` 链接**（编辑器可能剥掉自定义 `data-*`，但保留超链接；标题文字仅作显示）。
- **句身份 = `data-annotation` 内的 `annotationKey`**，同时保存文本快照、页码与 `attachmentURI`；原批注删除后句子仍在，跳转退化为按页打开。
- **宽松解析与定点编辑**：无法识别的用户手写段落原样保留，插入/删除只改目标节点，不整篇重写。

### 4.3 写入与回滚

集中在 `src/zotero/excerptNotes.ts` 串行执行（bridge 不提供写端点）：

- `addExcerpt(A, B, annotation, index?)`：校验同库常规条目、批注属于 A 的 PDF、库可写；同节内同一 `annotationKey` 去重。从 PDF 直接拖选文字松手时先整体校验，再建 `unizero:excerpt` 高亮批注，中途失败回滚新建的高亮。
- `removeExcerpt(A, B, annotationKey)`：仅移除对应高亮及紧随引注，保留同段用户手写内容；段落或节为空时再清理。多设备同步产生多条摘句笔记时逐条尝试，均未命中返回 `false` 交由界面提示。

### 4.4 索引边界

- `uniConnectionSync` 监听笔记增删改与标签变动。
- 被引条目 B 被删或进回收站时，`excerptsFrom(A)` 标 `missing: true` 保留展示，不静默丢弃。
- 只剩 `<h2>` 标题、高亮被删光的节：不进入 `excerptsFrom` / `excerptsAbout`，但 `relationsOf` 仍计入引用关系。

### 4.5 Bridge 输出

`GET /relations` 附带可选字段 `excerpts`（ping 能力 `excerpts`）：`loaded: false` 时照常返回，读取异常时省略该字段而不影响主响应。跳转链接 `zotero://open-pdf/…` 的 `page` 参数只取物理页 `pageIndex`；仅有印刷页码 `pageLabel` 时只带 `annotation`。

## 5. 界面与宿主约束

### 5.1 条目面板 References / Citations

`LiteratureSidebar` 经 `LiteratureSidebarPort` 从 `views.ts` 取数：

- **References**：挂过摘句的行置顶（含不在 provider 列表中但已手工摘句的同库文献）；顶部搜索同时过滤当前列表并检索全库；拖放到库外行时提示先点 `+`，绝不在拖放中途静默建条目。
- **Citations（纯本地）**：仅展示 `excerptsAbout(B)` 与 `relationsOf(B)`，刷新只重读本地索引，不请求 provider。

### 5.2 表面拆分

| 表面 | 范围 | 宿主 | 说明 |
| --- | --- | --- | --- |
| UniConnection sidebar | 单篇论文 | 条目面板区块 | `LiteratureSidebar`（`sidebar` 布局） |
| UniConnection full | 单篇论文 | 独立窗口 | 同一个 `LiteratureSidebar`（`full` 布局），侧重并排拖放摘句 |
| Unizero Home | 文库 / 分类 | 主窗口标签页 | 按最近改动查看论文与手工摘句网络 |

Zotero 端不再保留 Relation 标签页，但 `coupledWith` 与 bridge `kind=relation` 仍为 Obsidian 详情面板和 MCP 工具保留。

### 5.3 UniConnection full

- **无脚本窗口壳**：`uniconnection-full.xhtml` 不含脚本，bundle 经 `window.arguments[0]` 的 `onLoad` / `onUnload` 把 `LiteratureSidebar` 画入窗口，无独立构建入口；至多一扇，随所属主窗口或插件关闭。
- **双信号跟随**：同时监听条目面板 `onItemChange`（侧栏折叠时不触发）与 `tab` 的 `select`，每次都重新读取所属主窗口的当前活动标签，避免被后台面板或其他主窗口带偏；📌 固定后锁定目标论文，跨窗口拖放时校验来源 PDF 必须属于当前锁定论文。
- **按需远程 Citations**：本地组下方可展开“被引用（数据源）”，打开仅读本地缓存，用户显式点击获取/加载更多才请求 provider，并与本地组去重。

### 5.4 Unizero Home

- **标签类型与多视图工具栏**：通过 `Zotero_Tabs.add({ type: "unizeroHome", … })` 打开（类型名不能含 `-`，Zotero 会按 `-` 切分类型）；Zotero 9+ 单窗口可有多个文库视图，按钮需注入每条工具栏并在新标签打开时补齐。
- **会话恢复陷阱**：Zotero 启动时按保存的类型逐个恢复标签，遇到未注册 hook 的类型会直接抛错中止后续标签恢复。因此每个窗口都包装 `Zotero_Tabs.getState` 将 Home 从保存状态剔除（卸载时还原），并在支持 `tabHooks` 的版本注册 `restoreState` / `undoClose`。
- **行按改动、对端只认手工摘句**：左栏列出有本地活动的论文，但对端只取 `excerptPairs`（provider References 不代表用户摘录）。改动时间取四者最新：非空摘句笔记 `dateModified`、附件批注最新 `dateAdded`、非摘句子笔记最新 `dateModified`、`referencesLoadedAt`（旧缓存回退 `savedAt`）；右栏与对端排序只取对应批注的 `dateAdded`（批注已删则排后，不借用笔记修改时间以免被其他节污染）。
- **本地读写边界**：活动时间由 `src/zotero/uniConnectionActivity.ts` 用按库聚合 SQL 读取（批注在 SQL 内按论文计数取最新，单条批注时间只查摘句用到的键），不逐条实例化 `Zotero.Item`；行组装在纯函数 `unizeroHomeModel.ts`，论文摘要只为上榜行与对端生成。唯一写操作是点击 `+ Canvas` 时调用 `ensureCanvasAttachment`。选中与展开均原地更新 DOM，保证双击落在同一节点上。

### 5.5 重绘

条目面板、full 窗口与 Home 的行数据只在输入对象（快照、摘句、引用列表、Home 的 `view.data`）被替换时重算；行节点按 `列:行` 缓存复用，搜索、排序、展开只重新挂载已有节点。条目面板与 full 窗口的重绘合并到下一帧（`requestAnimationFrame`）。
