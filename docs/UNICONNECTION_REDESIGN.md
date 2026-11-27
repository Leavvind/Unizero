# UniConnection 重做：从笔记链接派生论文关系

> 中文设计文档，**部分实现**：Obsidian Paper pane 已改用派生关系（阶段 1），Zotero 侧尚未开始。现行行为见 [UNICONNECTION.md](UNICONNECTION.md) 与
> [UNIZERO_LINKS_DESIGN.md](UNIZERO_LINKS_DESIGN.md)；分阶段计划登记在
> [ROADMAP.md](ROADMAP.md#uniconnection-redesign)。

## 状态

| 部分 | 状态 |
| --- | --- |
| 链接角色模型（§3）、证据单元（§4） | 在用（Obsidian 侧：`documentLinks.ts` 的 `unit`、`paperRelations.ts`） |
| Obsidian Paper pane 改用派生关系（§5.2） | 在用（阶段 1） |
| 共享链接解析包、Zotero 侧索引、Uniconnection 标签页与论文页（§5.1、§7） | 未做（阶段 2） |
| `@` 在线搜索与入库（§6） | 未做（阶段 3），依赖新的桥接写接口 |
| 设计取舍（§10） | 已定（2026-11-27） |

## 1. 背景与问题

现行“引用摘句”（`unizero:excerpts` 子笔记，见 [UNICONNECTION.md §4](UNICONNECTION.md#4-引用摘句excerpts)）
把论文间关系存成 Zotero 里一条结构化笔记，带来三个问题：

1. **入口单一**：只能把 A 的 PDF 中已有的 Highlight 拖到 B 名下。
2. **来源单一**：只能从 A 的 PDF 出发，不能从其他笔记提到 B。
3. **不可编辑**：写入后只能删除，不能改写、合并或补充。

条目面板的 UniConnection sidebar 展示效果也不理想。另一方面，Raw / Canvas 本就是用户可编辑
的文本，`unizero://` 链接已经具备持久身份、索引和反链。

**方向：论文 → 论文关系从 Raw / Canvas 中的 `@` 链接派生。UniConnection 从写入工具变为
阅读与导航视图，写入只发生在 Obsidian 的笔记里。**

## 2. 已有基础

- 论文的 Canvas 是 Zotero 附件（`unizero:canvas`），Raw 是 `unizero:raw`。Obsidian 链接索引里
  这类来源记录为 `{ kind: "zotero", libraryID, itemKey, attachmentKey, purpose: "raw" | "canvas" | "user" }`
  （`apps/obsidian-plugin/src/linkIndex.ts`），`itemKey` 即所属论文。因此“A 的 Canvas 链接到 B”
  在数据上已经等于“论文 A 提到论文 B”，Backlinks 也已按 A 的标题分组显示
  （`apps/obsidian-plugin/src/backlinksView.ts`）。缺的只是把它当作论文关系来展示。
- 前提一：开启 **Index Zotero documents**。前提二：Canvas 必须是 Zotero 那份附件。Vault 里名为
  `Paper A.canvas` 的文件没有论文身份，文件名不是身份，这一点保持不变。
- 每条出现位置已记录 `line`、`lineText`，Canvas 来源还记录 `nodeId`，足以定位到卡片。

## 3. 链接角色模型

### 3.1 角色由位置推导，`@` 不分模式

`@` 只负责插入一个指向身份的链接，不让用户在插入时选模式。链接的角色由**来源位置**和
**目标**推导：

| 写在 | 指向 | 角色 | 出现在 |
| --- | --- | --- | --- |
| 论文 A 的 Raw / Canvas | 另一篇论文 B（含 B 的 PDF、Raw 等文件） | **Academic**：A → B | A 的 References、B 的 Citations、Links |
| 论文 A 的 Raw / Canvas | A 自己 | 自引、定位 | 仅 Links |
| Vault 笔记、普通 Markdown 附件 | 任意 | **Link** | 仅 Links / Backlinks |

- 指向论文的文件（`.pdf`、`.md`、`?attachment=`）按所属条目聚合。
- 判定只看来源附件的 `purpose` 与所属条目，不看标题或文件名。
- 由此不必给 `@` 增加模式：只区分 Academic（论文 → 论文）与 Link（非论文 → 论文），两者都能自动判定。

### 3.2 不做 Hide

暂不提供“只渲染、不计入关系”的标记。若以后需要，优先考虑 Markdown 链接 title
（`[text](unizero://paper/1/KEY "nocite")`）：URI 不变，旧版插件与 MCP 不会把链接判为非法；
给 URI 新增查询参数则会被现行严格解析拒绝，属于不兼容变更。

## 4. 证据单元：PDF 位置与链接的配对

`zotero://open-pdf` 与 `unizero://` 不再强绑定，改用固定、可解释的配对规则：

- **单元** = 同一个 Markdown 段落或列表项；Canvas 中是同一张文本卡片里的同一段。
- 单元中出现指向 B 的 `unizero://paper/…`，记为一条 A → B 提及。
- 同一单元中的 `zotero://open-pdf/…?annotation=…` 是这条提及的 PDF 锚点，可以有 0 个或多个；
  不跨段配对。
- 展示：单元原文（去掉链接语法）；PDF 按钮跳回原文位置；Canvas / Raw 按钮跳回笔记位置
  （Canvas 按 `nodeId` 聚焦卡片，Raw 按行或块）。
- 没有 PDF 链接的单元仍是有效提及，只是没有 PDF 按钮。这覆盖了“从完全不同的地方提及”。
- 用户改写段落即改写关系；不设独立的关系存储，不自动改写链接。

示例：A 的 Canvas 某张卡片有两段，各带一个 `[pdf](zotero://open-pdf/…&annotation=…)`。在第二段
加入 `@B` 后，B 的 Citations 显示“Paper A · Canvas”、第二段原文、第二段批注的 PDF 跳转和该卡片的
Canvas 跳转；第一段的批注不会被配入。

注意：Canvas 卡片聚焦尚未在宿主中验证（见
[宿主验收记录](UNIZERO_LINKS_DESIGN.md#宿主验收记录)）。

## 5. 界面

### 5.1 Zotero

- **删除**条目面板的 UniConnection sidebar（`src/ui/literatureSidebar.ts` 的 `sidebar` 布局）。
- **删除** UniConnection full 窗口（`src/ui/uniConnectionFull.ts`、
  `addon/chrome/content/uniconnection-full.xhtml`）。它存在是为了与 PDF 并排拖放摘句，写入移到
  Obsidian 后不再需要。
- **Unizero Home 显示名改为 Uniconnection。** 内部 tab 类型 `unizeroHome`、偏好键、feature ID
  不改名（[AGENTS.md](../AGENTS.md#stable-state)）。
- **双击论文标题**：在同一标签页内进入该论文的专属页，提供返回；PDF、Canvas 按钮行为不变。
  不为每篇论文开新 Zotero 标签，避免放大会话恢复问题（[UNICONNECTION.md §5.4](UNICONNECTION.md#54-unizero-home)）。
- **论文专属页**：
  - References：A 的 Raw / Canvas 提到的论文；
  - Citations：提到 A 的其他论文的 Raw / Canvas；
  - 每条带单元原文、PDF 跳转、Canvas / Raw 跳转；
  - 数据源书目（provider References / Citations / Relation）折叠为 Bibliography 区，打开只读缓存，
    用户点击才请求数据源。
- 首页左栏“有本地活动的论文”的活动来源相应改为 Raw / Canvas 提及与批注。

### 5.2 Obsidian Paper pane

现为 Links / References / Citations / Relation 四个标签（`apps/obsidian-plugin/src/detailView.ts`）：

- References / Citations 改为 §3 的 Academic 关系，直接从现有链接索引计算，无需新桥接接口：
  - References：`source.kind === "zotero"`、`purpose` 为 `raw` / `canvas`、`itemKey === A` 的记录中，
    指向其他论文的链接；
  - Citations：指向 A 的出现中，来源为其他论文 Raw / Canvas 的那些。
- Links 保留，放非论文来源与自引。
- 数据源书目（provider References / Citations / Relation）原样移入 Bibliography 标签，界面调整以后再议（§10 第 4 条）。
- 证据单元在扫描时随每条链接记入索引（`DocumentLink.unit`：段落纯文本，上限 600 字，以及同段的
  `zotero://open-pdf` 链接）。Zotero 文档的索引缓存因此升到 schema 3，旧缓存整份丢弃重扫。
- 单元内的 PDF 链接来自用户文本，打开前必须完全匹配 Zotero 的 `open-pdf` 形态，其余一律拒绝。
- 未开启 Zotero 文档索引时显示“未索引”，不能显示为 0（沿用覆盖状态规则）。

## 6. 库外论文：`@` 在线搜索与入库

- 本地结果优先；列表末行为“在线搜索 …”，只有用户显式选中才请求数据源，不随按键请求。
- 搜索与入库由 Zotero add-on 执行（数据源在那里）。需要新的桥接写接口（如 `POST /items`，按
  DOI / arXiv / S2 ID 导入），通过 `GET /ping` capability 宣告。这就是 ROADMAP 的
  “Import from Obsidian”，同时需修改 [ARCHITECTURE.md](ARCHITECTURE.md#bridge-contract) 中
  “POST 只作用于论文自己的转换与 Raw / Canvas”的约定，并同步更新 MCP 客户端。
- 入库前按 DOI 等标识查重；已存在则直接链接到现有条目，不建重复条目。
- 目标库：写在论文 A 的 Raw / Canvas 中时默认 A 所在库；写在 Vault 笔记中时用设置的默认库 / 分类。
- 确认框：**Yes** → 建条目 → 插入链接；**Cancel** → 不插入任何内容，也不渲染。

## 7. 架构影响

1. **共享链接解析包。** Zotero 的 Uniconnection 不能依赖 Obsidian 运行，add-on 必须自己解析
   Raw / Canvas 中的链接。把 `unizero://` 解析、Markdown / Canvas 链接扫描、证据单元提取抽到
   `packages/` 下的共享包，供插件、add-on、MCP 共用并统一测试，避免各端对“什么算一条提及”逐渐分歧。
   add-on 侧须满足无 Node 内置模块的约束。
2. **Zotero 侧索引刷新。** Obsidian 改动 Canvas / Raw 文件时 Zotero 收不到通知。打开 Uniconnection
   标签页时按修改时间与大小检查后重读；Raw 可能很大，需要指纹缓存，必要时放到 worker。
   索引仍是内存派生态，可重建，不写回附件或笔记。
3. **写入只在 Obsidian。** 不保留“在 Zotero 中拖高亮写入 Canvas”：Obsidian 打开同一 Canvas 时
   两边会互相覆盖。Zotero 侧唯一写操作仍是 `+ Canvas` 新建空 Canvas（以及 §6 的入库）。
4. **跨库关系。** 摘句要求同库是因为要写笔记；链接本身带 `libraryID`，跨库提及只是两端库不同的边，
   键仍为 `ScopedItemKey`，展示时标出库。
5. **provider References 索引保留。** `relationsOf`、`coupledWith`、bridge `kind=relation` 仍服务
   Bibliography 区与 MCP；[UNICONNECTION.md §1](UNICONNECTION.md#1-关键约束) 的约束继续有效。

## 8. 旧摘句的处理

- 新体系与现有 `@` 链接完全兼容：已经写在 Raw / Canvas 里的 `unizero://` 链接直接成为论文关系，
  不需要迁移。
- UniConnection 摘句（`unizero:excerpts`）保持原样：不迁移、不计入新的 References / Citations、
  不登记新的遗留读取器。阶段 2 退役 sidebar 与 full 窗口时，再决定摘句界面的去留。

## 9. 阶段

1. **Obsidian Paper pane** 的 References / Citations 改为链接派生。全在插件内，无契约变更，用于
   验证模型。
2. **共享解析包 + Zotero 侧索引**；Home 改名 Uniconnection 并加论文专属页；删除 sidebar 与
   full 窗口。
3. **`@` 在线搜索 + 入库**（新桥接写接口）。

## 10. 已定取舍（2026-11-27）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 是否提供 Hide？ | 暂不做；只区分论文 → 论文与非论文 → 论文（§3.2） |
| 2 | 哪些来源算论文笔记？ | 只认论文的 Raw / Canvas；普通 Markdown 附件不算；不使用 frontmatter 声明 |
| 3 | 旧摘句怎么办？ | 不处理，保持原样（§8） |
| 4 | Paper pane 的数据源书目？ | 属于界面问题，暂不调整，原样保留在 Bibliography 标签 |

## 11. 不变的约束

- 渲染、索引、打开面板不写 frontmatter，不触发数据源请求、运行时或转换。
- 只接管严格解析通过的 `unizero://`；不引入第二套链接语法。
- 证据单元配对是派生结果，不回写笔记、不自动补链接或改写锚点。
- 派生索引（Obsidian 链接索引、Zotero 关系索引）可删除重建，不写回分片、笔记或 Paper catalog。
