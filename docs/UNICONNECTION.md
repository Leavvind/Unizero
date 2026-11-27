# Uniconnection — 论文关系、书目索引与引用摘句

> 中文设计约束文档。Uniconnection 由两套纯内存派生层组成：
>
> 1. **笔记链接关系（主视图）**：从论文自身的 Raw / Canvas 附件扫描 `unizero://` 链接，派生论文 → 论文提及关系与原文证据单元，供 Obsidian Paper pane 与 Zotero Uniconnection 标签页消费；写入只发生在 Obsidian 笔记中。
> 2. **书目反向索引与引用摘句（`UniConnection`）**：从每篇论文已缓存的 provider References 分片与 `unizero:excerpts` 子笔记建立库内反向引用与文献耦合（`coupledWith`），供两侧 Bibliography 区、桥接 `GET /relations` 与 MCP 工具消费。

现行系统架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，链接语法与文档索引约束见 [UNIZERO_LINKS_DESIGN.md](UNIZERO_LINKS_DESIGN.md)，未完成项见 [ROADMAP.md](ROADMAP.md)。

## 状态

| 部分 | 状态 | 落点 |
| --- | --- | --- |
| 链接角色模型与证据单元（§1–§2） | 在用 | `packages/links`（`roles.ts`、`documentLinks.ts`） |
| Obsidian Paper pane 派生关系（§4.2） | 在用 | `apps/obsidian-plugin/src/paperRelations.ts`、`detailView.ts` |
| Zotero 侧链接索引与 Uniconnection 标签页（§3、§4.1） | 在用 | `src/modules/paperLinkIndex.ts`、`src/zotero/paperLinkSources.ts`、`src/ui/unizeroHome*.ts` |
| Vault 笔记提及推送至 Zotero（§3 第 4 条） | 在用 | 插件 `src/vaultMentionSync.ts`；add-on `src/modules/vaultMentionIndex.ts`、`src/zotero/vaultMentionStore.ts`、`POST /vault-mentions` |
| 书目反向索引与文献耦合（§5） | 在用 | `src/modules/uniConnection.ts`、`uniConnectionSync.ts`、`src/modules/views.ts` |
| 引用摘句存储、索引与 bridge 字段（§6） | 在用（无 Zotero 界面） | `src/zotero/excerptNote*.ts`、`src/server/`；条目面板与 full 窗口已退役 |
| Obsidian 展示引用摘句 | 未做 | [ROADMAP.md](ROADMAP.md#citation-excerpts) |
| `@` 在线搜索与入库（§7） | 未做 | [ROADMAP.md](ROADMAP.md#uniconnection)，依赖新的桥接写契约 |

## 1. 链接角色模型

`@` 插入一个指向持久身份的 `unizero://` 链接，插入时只区分两种渲染：

| 输入 | 写出 | 渲染 | 是否计入 |
| --- | --- | --- | --- |
| `@` | `[Author, 2020](unizero://paper/1/KEY)` | 论文为紫色徽标、Vault 笔记为青色点线 | 计入 References / Citations / Backlinks |
| `-@` | `[Author, 2020](unizero://paper/1/KEY "nocite")` | 灰色虚线框标签 | **不计入**任何关系或入链 |

`nocite` 链接照常打开 Paper pane、Raw、PDF 或笔记，只是不被任何索引记录（Obsidian 链接索引、Zotero 侧链接索引都跳过它），因此也找不到它的入链。标记用 Markdown 链接 title：URI 保持不变，旧版插件与 MCP 仍视为合法链接；给 URI 新增查询参数会被现行严格解析拒绝，属于不兼容变更。`-` 紧接在单词、`-`、`/`、`.` 之后时仍是普通文字（`pre-@` 按普通 `@` 处理）。

计入的链接再按**来源位置**与**目标**分组：

| 写在 | 指向 | 分组 | 出现在 |
| --- | --- | --- | --- |
| 论文 A 的 Raw / Canvas | 另一篇论文 B（含 B 的 `.pdf`、`.md`、`?attachment=`） | **Papers**：A → B | A 的 References、B 的 Citations；Zotero Uniconnection |
| 论文 A 的 Raw / Canvas | Vault 笔记 N | **Notes** | A 的 References；N 的 Backlinks |
| 论文 A 的 Raw / Canvas | A 自己 | **Notes**（自引、定位） | A 的 Citations |
| Vault 笔记、普通 Markdown / Canvas 附件 | 论文 B | **Notes** | B 的 Citations；Backlinks；Vault 笔记另见 Zotero Uniconnection 的 Citations（§3 第 4 条） |
| Vault 笔记 | Vault 笔记 | — | 只在 Backlinks，不进 Paper pane |

- **论文笔记的唯一判定**：只认 Zotero 附件中 `purpose` 为 `raw`（`unizero:raw`）或 `canvas`（`unizero:canvas`）的文档，按所属条目 `libraryID + itemKey` 归属。普通 Markdown 附件不算论文笔记；Vault 里同名的 `Paper A.canvas` 没有论文身份；不使用 frontmatter 声明论文归属。
- **按条目聚合目标**：指向论文下属文件（`.pdf`、`.md`、`?attachment=`）的链接一律按所属论文聚合。
- **Papers 只认论文笔记**：Papers 组完整进入 Zotero 侧 Uniconnection 标签页；Notes 组中只有“Vault 笔记 → 论文”经插件推送进入 Zotero，且只作为被提及论文的 Citations（Vault 笔记不是论文，没有 References，也不计入左栏活动）。论文指向 Vault 笔记、普通 Markdown / Canvas 附件提及论文，仍只在 Obsidian Paper pane 显示。

## 2. 证据单元与 PDF 锚点

`zotero://open-pdf` 与 `unizero://` 不强绑定，改用基于结构块的固定配对规则（`DocumentLink.unit`）：

- **单元** = 同一个 Markdown 段落、列表项或标题块；Canvas 中为同一张文本卡片里的同一段。单元原文去掉链接语法后保留纯文本（上限 600 字）。
- 单元中出现指向 B 的 `unizero://paper/…` 记为一条 A → B 提及；**同一单元内多次链接同一篇论文只算一条提及**。
- 同一单元中的 `zotero://open-pdf/…` 作为这条提及的 PDF 锚点，可以有 0 个或多个，绝不跨段配对。没有 PDF 链接的单元仍是有效提及，只是没有 PDF 按钮。
- **PDF 锚点校验与退化**：单元内的 PDF 链接来自用户文本，打开前必须精确匹配 Zotero 的 `open-pdf` 形态（`parsePdfAnchor`），且只打开对应文库的 PDF 附件，其余一律拒绝。优先按 `annotation` 打开；原批注已删时按物理页 `page`（`pageIndex = page - 1`）打开。
- **纯派生、不回写**：用户改写段落即改写关系；不设独立关系存储，不回写笔记，不自动补链接或改写失效锚点。

## 3. 共享解析与双端索引

1. **共享链接解析包（`packages/links`，`@unizero/links`）。** Zotero 的 Uniconnection 不能依赖 Obsidian 运行，add-on 必须独立解析 Raw / Canvas 中的链接。`unizero://` 语法、Markdown / Canvas 结构扫描、证据单元提取、角色判定与 PDF 锚点解析集中在 `packages/links`，无宿主 API、无 Node 内置模块。插件与 add-on 经 `file:` 依赖各自打包（add-on 构建把 `decode-named-character-reference` 固定到无 DOM 实现；MCP 目前不扫描笔记，尚未使用）。
2. **Zotero 侧链接索引（`paperLinkIndex.ts`、`paperLinkSources.ts`）。** Obsidian 修改 Canvas / Raw 时 Zotero 收不到文件通知，因此在打开或刷新 Uniconnection 标签页时经 `listLinkSources` 扫描所有文库的 Raw / Canvas：
   - 指纹为 `附件版本 + 文件大小 + 修改时间`，未变文件不重读；不含 `unizero` 的文本直接跳过解析；每解析 8 个文件让出一次事件循环（暂未放到 worker，大库实测卡顿再议）。
   - 纯内存派生态，可删除重建，关闭时清空，不写回附件、笔记或缓存分片。
   - 读取失败的文件（如保存中途的 Canvas）保留上次提及并在状态栏计数，下次刷新重读；不在本机的附件不计入，状态栏单独计数。
   - **支持跨库提及**：链接自带 `libraryID`，跨库边键仍为 `ScopedItemKey`，展示时标出所属文库。
3. **Obsidian 侧索引（`linkIndex.ts`）。** 扫描时将 `unit` 随每条链接记入索引（Zotero 文档索引缓存升至 schema 4：`nocite` 链接不入索引，旧缓存整份丢弃重扫）。需开启 **Index Zotero documents**；未开启时显示“未索引”，不能显示为 `0`。
4. **Vault 提及推送（`POST /vault-mentions`）。** Zotero 读不到 Vault，也不另建 Vault 索引；由已经索引 Vault 的插件把“Vault 笔记 → 论文”的提及整份推给 add-on：
   - **内容**：每条为被提及论文的 `libraryID + itemKey`、笔记路径与标题、格式、行号、Canvas 卡片 ID、证据单元原文与同段 PDF 锚点、笔记修改时间；同一单元内多次链接同一篇论文只算一条；`nocite` 链接本就不在索引中。Zotero 自己的 Raw / Canvas / 普通附件不推送（add-on 自行扫描论文笔记）。
   - **时机**：Vault 索引完成一轮（`complete` 或 `partial`）后，索引变动停止 5 秒再发；与上次已发内容相同则不发；失败或 add-on 未宣告 `vault-mentions` 能力时 60 秒后重试。设置项 **Show Vault notes in Zotero**（默认开）可关闭。Vault 换了新 `vaultID` 时先为旧 ID 发空快照，避免残留。
   - **Zotero 侧存储**：按 `vaultID` 整份替换，格式错误整份拒绝（400），PDF 锚点只保留严格匹配 `open-pdf` 形态的。快照缓存在 `<dataDir>/unizero/vault-mentions.json`，属派生缓存：删除后等下次推送重建；Obsidian 关闭时显示最后一次快照，状态栏标出同步时间。不触碰任何 Zotero 条目。
   - **打开**：路径只作标签和回传地址，Zotero 从不读取。按钮调用 `obsidian://unizero?vault=…&vaultID=…&file=…&line=…&node=…`（Vault 内相对路径用 `file`，因为 Obsidian 自己把 `path` 当作绝对文件系统路径来选 Vault）；插件核对 `vaultID` 与路径确为本 Vault 的笔记后，在行或卡片处打开，否则提示而不猜测。
5. **写入只在 Obsidian。** 不提供“在 Zotero 中拖高亮写入 Canvas”：Obsidian 打开同一 Canvas 时两边会互相覆盖。Zotero 侧在 Uniconnection 中的唯一写操作是 `+ Canvas` 新建空 Canvas（`ensureCanvasAttachment`）。

## 4. 界面与宿主边界

### 4.1 Zotero Uniconnection 标签页

实现位于 `src/ui/unizeroHome.ts`、`unizeroHomeModel.ts`、`src/zotero/uniConnectionActivity.ts`、`src/zotero/pdfAnchors.ts`：

- **显示名与稳定标识**：原 Unizero Home 显示名改为 **Uniconnection**（工具栏按钮打开总览，条目右键菜单 **Show in Uniconnection** 直接打开论文页）；内部 tab 类型 `unizeroHome`（不能含 `-`，Zotero 会按连字符切分类型）、偏好键与 feature ID `literature.relations` 保持不变（[AGENTS.md](../AGENTS.md#stable-state)）。会话恢复包装（`Zotero_Tabs.getState` 剔除本标签）与多工具栏约束见 [ARCHITECTURE.md](ARCHITECTURE.md#host-surface-uniconnection)。
- **退役旧表面**：条目面板的 UniConnection sidebar 与独立的 `UniConnection full` 窗口已退役（原用于与 PDF 并排拖放摘句，写入移至 Obsidian 后不再需要）。
- **总览双栏与活动信号**：左栏（References）按最近活动列出正在处理的论文及其提及的对端；右栏（Citations）列出被提及的论文及提及方。活动时间只取两类本地信号：所在 Raw / Canvas 文件的修改时间（文件无段落级时间）与附件批注最新 `dateAdded`（单条按库聚合 SQL 查询，不逐条加载批注条目）；不再计入普通笔记编辑与 References 载入。
- **单标签内论文页**：双击论文标题或点击相关论文在同一标签页内进入专属页，**Back** 逐级返回直至总览（切换文库或分类回到总览），不为每篇论文新开 Zotero 标签以免放大会话恢复问题。
  - **References / Citations**：展示单元原文、PDF 按钮与 Raw / Canvas 按钮。从 Zotero 打开 Raw / Canvas 仅调用 `viewAttachment` 打开该附件，**不能**定位到行或卡片（定位在 Obsidian Paper pane 中完成）。
  - **Bibliography（折叠区）**：收纳数据源 References / Citations 与库内 Relation（`coupledWith`），展开只读缓存，显式点击 **Fetch** 才请求数据源。
- **Vault 笔记**：总览右栏与论文页 Citations 同时列出提及该论文的 Vault 笔记（§3 第 4 条），徽标 `✎` 单独计数，论文页另设 “Vault 笔记” 小节；每段显示单元原文、PDF 按钮与 **Obsidian** 按钮（在行或卡片处打开）。收到新快照时，已打开的标签页自动重载。

### 4.2 Obsidian Paper pane

右侧详情面板（`apps/obsidian-plugin/src/detailView.ts`、`paperRelations.ts`）设三个标签，原 **Links** 标签并入 Citations：

- **References**（出链）/ **Citations**（入链）：直接从共享链接索引重算 §1 的分组，各分 **Papers** 与 **Notes** 两组（按提及次数排序，同组内 Canvas 排在 Raw 前，再按阅读顺序）。每段显示所在单元原文，支持跳至 Raw / 笔记行、跳至 Canvas（Vault Canvas 聚焦卡片；论文 Canvas 由系统打开，不能定位卡片，见 [UNIZERO_LINKS_DESIGN.md](UNIZERO_LINKS_DESIGN.md#宿主验收记录)）以及按同段锚点打开 PDF。References 依赖 **Index Zotero documents**；未开启时 Citations 只显示 Vault 来源并标明 Zotero 文档未索引。
- **Bibliography**：原样保留数据源 References / Citations / Relation 列表，只读缓存，显式点击才请求数据源。

## 5. 书目反向索引与文献耦合

`UniConnection`（`src/modules/uniConnection.ts`、`uniConnectionSync.ts`）维护库内书目反向引用与耦合索引，服务两侧的 Bibliography 区（`Relation`）、桥接 `GET /relations` 与 MCP 工具。

### 5.1 关键约束

1. **纯派生、不抓取、不写回。** 只消费 `References-Resolved-v4` 分片与带 `unizero:excerpts` 标签的子笔记（§6）；反向边绝不写回被引论文的分片或笔记。
2. **哑边不能当端点。** `edgeIdentity` 对缺少 DOI / arXiv / S2 `paperID` 的条目返回 `undefined`（用标题拼 key 会静默合并同名异文）。摘句边两端都是库内条目，直接用 `ScopedItemKey`。
3. **索引建在所有边上，库内过滤在查询时施加。**
4. **索引不含 Zotero 显示字段。** 只存 `ScopedItemKey` 与 `EdgeKey`（摘句例外保留用户原文快照），标题、年份由消费方在展示时富化。
5. **批量 `build` 走分片直读，绕过 32 条驻留 LRU。** 先列一次缓存目录，只读有分片的条目；分两段：条目与摘句笔记先就绪，`excerptsFrom` / `excerptsAbout` / `excerptPairs` 不等分片；`relationsOf`、`coupledWith`、`referencesLoadedAt` 等全部分片读完才返回。构建期间的条目与笔记变动同时写入构建中的索引，避免被构建结果覆盖。
6. **单篇路径读缓存前必须 `await load(item)`。**
7. **多库隔离。** `ScopedItemKey` 一律含 `libraryID`；摘句引用端与被引端必须同库。
8. **身份变更走 `retract` + `ingest`**（事后补 DOI 会改变 `selfEdge`）。
9. **写入先于读取。** References 刷新须 `await` 缓存写入与 `ingestItem` 后再返回；摘句写完立即 `ingestExcerptNote`。

### 5.2 结构与查询

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
- `coupledWith(P)`：与 P 共享参考文献最多的库内论文（驱动两侧 Bibliography 的 `Relation` 与 bridge `kind=relation`）。
- `excerptsFrom(A)` / `excerptsAbout(B)` / `excerptPairs(libraryID)`：A 挂在各被引文献下的摘句 / 库内提到 B 的摘句 / 全库 `(citing → cited)` 摘句对。

**为什么建在 References 而不是 Citations 上：** 单篇 References 有界且已缓存，Citations 无界；库内反向引用受文库规模限制，可本地精确计算。

### 5.3 明确不做

- 反向边写回分片、用标题拼边 key、拉全量 Citations 建图。
- 跨库摘句，或直接对库外论文挂摘句。
- 已退役的全库图谱、单篇 Graph 标签与旧 Board 视图（不恢复）；索引落盘待大库实测卡顿再议。

## 6. 引用摘句

条目面板与 `UniConnection full` 退役后，引用摘句在 Zotero 中没有展示或写入界面。已有摘句保持原样：**不迁移、不计入链接派生的 References / Citations、不登记新的遗留读取器**。保留不变的部分包括 `unizero:excerpts` 子笔记本身、索引中的摘句查询以及 bridge `GET /relations` 的 `excerpts` 字段；`src/zotero/excerptNotes.ts` 与 `excerptAnnotations.ts` 的写入与拖放解析目前没有界面调用方。

- **存储格式（引用方 A 的子笔记）**：每篇 A 至多一条带 `unizero:excerpts` 标签的子笔记（按标签认所有权，不靠标题），随 Zotero 同步，卸载插件后仍可读可跳；被引方 B 永远只读：

  ```html
  <div data-schema-version="9">
  <h1>Cited passages</h1>
  <h2><a href="zotero://select/library/items/B_KEY">Dick-Nielsen (2014)</a></h2>
  <p><span class="highlight" data-annotation="%7B…annotationKey…%7D">“Following Dick-Nielsen (2014), …”</span>
   <span class="citation" data-citation="%7B…%7D">(<span class="citation-item">A, 2020, p. 7</span>)</span></p>
  </div>
  ```

  - **节身份** = `<h2>` 内 `zotero://select/…/items/KEY` 链接（编辑器可能剥掉自定义 `data-*`，但保留超链接；标题文字仅作显示）。
  - **句身份** = `data-annotation` 内的 `annotationKey`，同时保存文本快照、页码与 `attachmentURI`；原批注删除后句子仍在，跳转退化为按页打开。
  - **宽松解析与定点编辑**：无法识别的用户手写段落原样保留，插入/删除只改目标节点，不整篇重写。
- **写入与回滚（`excerptNotes.ts`）**：串行执行（bridge 不提供写端点）。`addExcerpt(A, B, annotation, index?)` 校验同库常规条目、批注属于 A 的 PDF、库可写，同节内同一 `annotationKey` 去重；从 PDF 直接拖选文字时先整体校验再建 `unizero:excerpt` 高亮批注，中途失败回滚新建高亮。`removeExcerpt(A, B, annotationKey)` 仅移除对应高亮及紧随引注，保留同段手写内容，多设备同步产生多条摘句笔记时逐条尝试。
- **索引边界**：`uniConnectionSync` 监听笔记增删改与标签变动；被引条目 B 被删或进回收站时 `excerptsFrom(A)` 标 `missing: true` 保留展示；只剩 `<h2>` 标题的空节不进 `excerptsFrom` / `excerptsAbout`，但 `relationsOf` 仍计入引用关系。
- **Bridge 输出**：`GET /relations` 附带可选字段 `excerpts`（ping 能力 `excerpts`），`loaded: false` 时照常返回，读取异常时省略该字段而不影响主响应。跳转链接 `zotero://open-pdf/…` 的 `page` 参数只取物理页 `pageIndex`；仅有印刷页码 `pageLabel` 时只带 `annotation`。

## 7. 未完成扩展

**库外论文 `@` 在线搜索与入库**（[ROADMAP.md](ROADMAP.md#uniconnection)）：

- 本地结果优先；`@` 列表末行为“在线搜索 …”，只有用户显式选中才请求数据源，不随按键请求。
- 搜索与入库由 Zotero add-on 执行，需要新的桥接写接口（如 `POST /items`，按 DOI / arXiv / S2 ID 导入），通过 `GET /ping` `capabilities` 宣告；落地时需同步更新 [ARCHITECTURE.md](ARCHITECTURE.md#bridge-contract) 中“POST 只作用于论文自己的转换与 Raw / Canvas”的约定及 MCP 客户端。
- 入库前按 DOI 等标识查重；已存在则直接链接现有条目，不建重复条目。
- 目标库：写在论文 A 的 Raw / Canvas 中时默认 A 所在库；写在 Vault 笔记中时用设置的默认库 / 分类。
- 确认框：**Yes** → 建条目并插入链接；**Cancel** → 不插入任何内容，也不渲染。

## 8. 全局不变量

- 渲染、索引、打开面板不写 frontmatter，不触发数据源请求、运行时启动或文档转换。
- 只接管严格解析通过的 `unizero://`；不引入第二套链接语法。
- 证据单元配对与书目反向索引均为内存派生结果，可删除重建，不写回分片、附件、子笔记或 Paper catalog。
