# UniConnection — 派生关系索引与引用摘句

> 中文设计文档。**一个纯派生层：用全库每篇论文已缓存的 References，以及用户亲手挑选的
> 引用摘句（Excerpts），建库内引用关系索引。** 条目面板的 References / Citations、
> Unizero Home 的 Relation 与 bridge 详情都是只读消费者。

## 状态

| 部分 | 状态 | 落点 |
|---|---|---|
| 内存索引 + 增量维护 | 在用 | `src/modules/uniConnection.ts`、`uniConnectionSync.ts` |
| 摘句：笔记格式、写入、索引、bridge 字段 | 在用 | `src/zotero/excerptNote*.ts`、`excerptAnnotations.ts`；`src/server/` |
| 条目面板 References / Citations | 在用 | `src/ui/literatureSidebar.ts`、`literatureSidebarModel.ts` |
| Relation（Home）/ Obsidian 详情 | 在用 | `views.ts` + bridge |
| 摘句排序、Home 重建、Obsidian 展示摘句 | 未做 | [ROADMAP.md](ROADMAP.md#citation-excerpts) |

现行行为：[ARCHITECTURE.md](ARCHITECTURE.md)。§1 的约束最该反复读。

## 1. 关键约束（必须遵守）

1. **纯派生、不抓取、不写回。** 只消费两种来源：`References-Resolved-v4` 分片，和带
   `unizero:excerpts` 标签的摘句笔记（§4）。真相永远在这两处；反向边不写回被引论文
   的分片，也不写进被引论文的任何笔记。
2. **哑边不能当端点。** `edgeIdentity` 对没有 DOI/arXiv/paperID 的条目返回
   `undefined`——用标题拼 key 会把不同论文悄悄合并。摘句边不需要 EdgeKey：两端都是
   库内条目，直接用 ScopedItemKey。
3. **索引建在所有边上，不只库内成员。** 库内过滤只在查询时施加。
4. **索引不含 Zotero 字段。** 只存 ScopedItemKey 与 EdgeKey；title、year 等由
   消费方从 Zotero 条目富化。摘句例外地携带原文快照（它本就是用户内容）。
5. **批量 build 走分片直读，不走 LRU。** resident 只有 32；全库 `load` 会淘汰交互集。
6. **单篇路径读缓存前必须 `await load(item)`。**
7. **多库隔离。** ScopedItemKey 一律带 `libraryID`。摘句的被引端必须与引用端同库。
8. **身份变更走 retract + ingest。** 事后补 DOI 会改变 self-edge。
9. **写入先于读取。** References 刷新 await 缓存写入与 `ingestItem` 之后 bridge 才
   resolve；摘句写入同理，先 `ingestExcerptNote` 再返回。

## 2. 结构与查询

```ts
type EdgeKey = string;       // "doi:…" | "arxiv:…" | "s2:…"
type ScopedItemKey = string; // `${libraryID}:${itemKey}`

// References 层
inverted:  Map<EdgeKey, Set<ScopedItemKey>>;
forward:   Map<ScopedItemKey, Set<EdgeKey>>;
selfEdge:  Map<ScopedItemKey, EdgeKey>;

// 摘句层（§4），按笔记存，笔记改动整体替换
excerptNotes: Map<number /* 笔记 itemID */, {
  citing: ScopedItemKey;
  sections: { cited: ScopedItemKey; excerpts: ExcerptRecord[] }[];
}>;
excerptedBy:  Map<ScopedItemKey /* 被引 */, Set<number /* 笔记 itemID */>>;
```

查询：

- `relationsOf(P)` — 库内谁引用了 P：References 缓存含 P，或摘句笔记有 P 的一节；
- `coupledWith(P)` — 与 P 共享参考最多的库内论文；
- `excerptsFrom(A)` — A 的每篇被引文献下挂了哪些句子；
- `excerptsAbout(B)` — 库内哪些论文、用哪些句子提到了 B。

**为什么是 References 而不是 Citations：** References 有界且已缓存；Citations 无界。
库内关联边受库大小限制，可精确本地计算。

## 3. 明确不做

- 把反向边写回被引论文的分片。
- 用标题给哑边造 key。
- 把 Citations 拉全当作图原料。
- 摘句指向库外论文（先加入 Zotero，§4.1）；跨库摘句。
- 全库总览图、管理表、单篇 Graph 标签、Board hover 提示（已删除，不恢复）。
- 暂不做：索引落盘水位线（库大到重建卡顿时再做）。

## 4. 引用摘句（Excerpts）

### 4.1 是什么

读论文 A 的 PDF 时，用户把 A 中提到 B 的句子（Zotero 批注）挂到 A 的 References 里
B 那一行下面。之后：

- A 的 References：B 那一行可展开，看到这些句子；挂过句子的行排在最前；
- B 的 Citations：最上面是“库里谁、用哪几句提到了我”，点句子跳回 A 的 PDF 对应批注；
- `relationsOf(B)` 计入 A，即使 A 的 References 缓存里没有 B。

句子是**用户自己选的内容**，不是派生数据，所以不存进 References 缓存（会被刷新覆盖）。

**被引的 B 必须已在库中，且与 A 同库。** 三种情况：

1. A 的 References 里有 B、B 不在库：行上的 `+` 加入 Zotero，再挂句子；
2. A 的 References 里没有 B、B 在库：顶部搜索（References 与整个库一起搜）找到 B；
3. 都没有：用户自己把 B 加进 Zotero，回到情况 2。

### 4.2 存储：A 的一条子笔记

每篇引用方 A 至多一条摘句笔记：A 的子笔记，带自动标签 `unizero:excerpts`（所有权按
标签，不按标题）。每篇被引文献一节，节内是 Zotero 原生的批注引用：

```html
<div data-schema-version="9">
<h1>Cited passages</h1>
<h2><a href="zotero://select/library/items/B_KEY">Dick-Nielsen (2014)</a></h2>
<p><span class="highlight" data-annotation="%7B…annotationKey…%7D">“Following Dick-Nielsen (2014), …”</span>
 <span class="citation" data-citation="%7B…%7D">(<span class="citation-item">A, 2020, p. 7</span>)</span></p>
</div>
```

- **节的身份 = `<h2>` 里的 `zotero://select/…/items/KEY` 链接。** 超链接在用户手改后仍保留；
  自定义 `data-*` 属性可能被笔记编辑器清掉，不依赖它。标题文字只是显示。
- **句子的身份 = `data-annotation` 里的 `annotationKey`。** 同时保存原文快照、页码、
  所在 PDF（`attachmentURI`）。批注被删后句子仍在，跳转退化为按页打开。
- **随 Zotero 同步；卸载 UniZero 仍可读、可点。**
- 只写在引用方 A 身上；B 永远只读。
- 解析宽松：用户手改、增删段落、加自己的文字都不让整条笔记失效；无法识别的内容原样
  保留，写入只做定点插入 / 删除，不整体重写。

### 4.3 写入

都在 `src/zotero/excerptNotes.ts`，串行化：

- `addExcerpt(A, B, annotation, index?)`：校验 B 是同库常规条目、批注属于 A 的 PDF、
  库可编辑；没有笔记就创建；没有 B 的节就追加一节；同一批注在同一节内不重复。
- `removeExcerpt(A, B, annotationKey)`：只删那条高亮及紧随的引注；段落里用户自己的
  文字或图片保留，段落空了才整段删除，节空了才删标题。A 有多条摘句笔记（两台设备
  同步前各建一条）时逐条尝试；一条都没改动则返回 false，侧栏据此提示用户手动删除。
- 拖放先整体校验（来源 PDF、可写、有文字），再创建高亮；中途失败会擦除本次新建的高亮。
- 写完立即 `ingestExcerptNote`（约束 9）。

Bridge 不提供写入端点；Obsidian 只读展示。

### 4.4 索引与维护

- `build(libraryID)` 同时扫描该库带 `unizero:excerpts` 标签的笔记。
- `uniConnectionSync` 的条目观察者对笔记也生效：带标签的笔记 add / modify → 重新解析；
  标签被移除、笔记进回收站或删除 → retract。
- 被引条目 B 被删除或进回收站：`excerptsFrom(A)` 仍报告这一节，标为 `missing`，
  不静默丢弃（笔记里的数据还在）。
- 只剩标题、没有高亮的节（用户删光了高亮但留下自己的文字）：不出现在 `excerptsFrom` /
  `excerptsAbout` 里，但 `relationsOf` 仍把 A 计为 B 的引用方。

### 4.5 Bridge

`GET /relations` 带可选字段 `excerpts`（ping 能力 `excerpts`，版本不变）：

- `kind=references`：A 挂过句子的被引文献，每组一个被引条目；
- `kind=citations`：库内提到 B 的引用方，每组一个引用条目；
- provider 缓存未加载（`loaded: false`）时也返回——它不依赖 provider；
- 读取摘句失败时省略该字段，relations 本身照常返回。

每句带 `annotationKey`、`attachmentKey`、`pageLabel`、`text` 和
`zotero://open-pdf/…?page=…&annotation=…` 跳转链接。`page` 只取自高亮的 `pageIndex`
（PDF 中的位置）；只有印刷页码 `pageLabel` 时链接只带 `annotation`。

## 5. 界面

### 5.1 条目面板 References / Citations

独立 UI 模块；`views.ts` 只通过 `LiteratureSidebarPort` 提供数据，`PanelStatus` 挂在
这一区块上。

**行**

- 每行最多两行（作者年份 + 标题，超出省略），展开后显示全文；
- 在库 / 不在库用行左侧细色线区分，不在库的行文字略淡、带 `+`；
- 挂过句子的行可展开：点句子跳回 PDF，× 删除；
- 悬停卡片的标题：库内文献打开其 PDF（无附件则在库中选中），库外文献打开 DOI 页；
- Ctrl/Cmd 点击：库内文献在库中选中，库外文献打开 DOI 页。

**References**

- 挂过句子的行最前（含 A 的 References 里没有、手动关联的被引文献），其余按 provider
  顺序，默认显示前 15 条，末尾“显示全部”；
- 顶部统一搜索：同时过滤列表并搜整个库，库内命中放在“来自文库”分组；
- 挂句子：① 从批注栏拖一条批注；② 直接从 PDF 拖选中文字——松手时在 A 的 PDF 上建
  一条高亮批注（标签 `unizero:excerpt`），再挂到行上。拖到不在库的行上提示先点 `+`，
  不在拖放时建条目；
- 打开即读缓存；缓存缺失且有 DOI / S2 ID / ZoMiner 参考文献时自动获取；缺标题的缓存行
  在后台继续解析。⟳ 从 provider 重新获取。

**Citations：只读文库，不联网**

- 顶部 `excerptsAbout(B)`（默认展开），下面是 `relationsOf(B)` 里其余的库内论文，按年份
  新→旧；⟳ 只重读本地索引；
- 只有已加载过 References 的论文才会出现；provider 的 Citations 留在 Home 与 bridge
  `fetch=1`。

### 5.2 Unizero Home 重建（未做）

- 与条目面板同一套行与交互，另加大表格、筛选、按来源刷新、provider Citations；
- 单独的 esbuild 入口、TypeScript、有类型检查；行组件与条目面板源码共用、各自打包；
  运行时仍只经 `window.arguments[0]` 通信（AGENTS 规则 10）；
- 落地时更新 AGENTS.md 组件表与 `LEGACY_HOME.md`。
