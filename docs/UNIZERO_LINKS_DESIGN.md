# UniZero 链接：设计约束

统一链接、Vault UID、文档链接索引和 Backlinks 已在 0.11.0–0.12.0 实现。本文只保留改动这些功能时仍须遵守的决策和约束，以及未完成的宿主验收；用法见 [插件说明](../apps/obsidian-plugin/README.md)，桥接字段见 [桥接约定](ARCHITECTURE.md#bridge-contract)，仓库规则见 [AGENTS.md](../AGENTS.md)。

这里的“链接”指文档中实际写出的链接，不等于论文书目的 References / Citations，也不从标题相似度推断。

## 身份

- **Zotero 目标**：`libraryID + itemKey`，可选 `attachment=<attachmentKey>`。附件 key 只在所属 Item 内解析，不跨库、跨 Item 猜测。
- **Vault 目标**：`vaultID + UID`。`vaultID` 是插件设置里的逻辑标识，随设置同步；复制成独立 Vault 必须走显式的 **Treat as a new Vault…**，不静默重置。
- **路径不是身份**：`vaultID + UID → 当前路径` 是可重建映射。同一 Vault 内改名、移动只更新映射，不改写引用文档。
- **UID 复用用户已有体系**，默认 `uid` frontmatter，文件名 UID 需显式配置捕获规则。UID 是不透明字符串：不当日期解析，不丢前导零。
- **只在用户动作时写 UID**（设置 UID、链接到无 UID 的笔记、Unlinked mentions 的 **Link**）；渲染、索引、打开面板永不写 frontmatter。不引入与用户生成器竞争的后台生成器。
- **UID 重复时**列出全部候选并停止导航，不按路径或打开顺序挑一个。用户修改 UID 即身份改变，不按标题自动接回。
- **跨 Vault**：只提示打开对应的逻辑 Vault，不扫描磁盘；跨 Vault 迁移与重定向未实现。

## URI

- 格式：`unizero://paper/<libraryID>/<itemKey>[.pdf|.md][?attachment=…&page=N][#标题|#%5E块ID]` 与 `unizero://note/<vaultID>/<UID>[#…]`。完整示例在插件说明里。
- 路径段、查询值和片段分别编码，解析时只解码一次。非法身份、冲突参数、非法页码、未知目标类型一律拒绝，不降格成另一种目标。
- `page` 是正整数物理页，不是印刷页码；不再引入 `.pdf.N` 之类的第二套语法。
- 无 `attachment` 表示默认文件；显式附件不存在时报错，绝不改开其他附件。
- 链接文字是用户的普通 Markdown，插入后不再随 Zotero 元数据重写；生成标签时转义方括号。所有插入入口（`@`、`-@`、侧栏、搜索弹窗、拖放）共用同一个序列化器；`-@` 只多写 title `"nocite"`，补全标题或块时保留该 title。
- `unizero://` 只在装了插件的 Obsidian 内有效，不是系统协议；应用外用 `obsidian://unizero?target=…`，二者解析为同一目标。
- 只接管严格解析通过的 `unizero://`；普通链接、`zotero://`、`obsidian://` 和原生 `[[...]]` 保持原生行为。不引入 `[[@...]]`。
- 裸 `@libraryID/itemKey` 自 0.11.0 之后只是普通文本（当时提供过一次性的 Transition 命令，已移除）。

## 定位失效

文件身份能解析，就一定打开该文件；定位失败只轻提示，不把整条链接判为失效。

| 情况 | 行为 |
| --- | --- |
| 标题或块存在 | 打开并定位（块内容改了但 ID 还在，照样定位） |
| 标题改名、删除或有多个候选 | 打开文件，提示定位不可用或有歧义 |
| 块 ID 删除 | 打开文件，提示块定位不可用 |
| `.md^`、`.md#^` 等未写完的定位 | 打开同一文件，保留显式附件 |
| UID 重复 | 显示冲突，不打开任何文件 |
| 文件或显式附件不可用 | 提示缺失或未同步，不创建同名文件 |

不自动改写失效锚点，不按相似内容重建链接。块定位只用已有块 ID，不把行号当持久 ID；创建块 ID 若实现，必须是可撤销的显式编辑。Raw 由 Obsidian 原生编辑器打开原附件定位，插件不再自带 Raw 编辑器，也不生成第二份 Raw。

## 索引

- 来源与目标分开建模：A 链接 B 不意味着 B 链接 A。保留每个出现位置；按文件或 Item 聚合只是另算的计数。
- 无 UID 的 Vault 笔记仍按路径索引其出链，只有被选作目标时才需要 UID。
- 用 Markdown 结构解析，跳过代码和注释；Canvas 只读文本卡片、分组标签和连线标签，不扫描任意 JSON 字段。
- 一个 Zotero 文件即使在 Obsidian 中打开，也只算 Zotero 来源，不重复算作 Vault 文件。
- Zotero 来源只从桥接的 `GET /link-sources` 获得：不遍历 Zotero storage，也不在插件里复刻附件身份规则（不靠标题认 Raw）。Raw Backup、派生导出和摘要不算来源。
- Zotero 文档索引需显式开启；后台刷新只读桥接和本地文件，不触发提供商请求、运行时或转换。
- 只有成功读到的空内容才清除某来源的旧出链；读取失败、文件缺失、桥接离线时保留旧记录并标记过期。只有完整扫描才能据清单删除来源，分页中断不清空。
- 重建和增量读取带代次，旧的异步结果不能覆盖新结果，卸载后不再写入。
- 索引是可删除的派生缓存，不回写书目关系缓存、Paper catalog 或附件元数据。各窗口共享一个索引，视图只订阅和查询。
- 覆盖状态必须可见：未建立、更新中、完成、部分覆盖（如旧 add-on 缺少能力）、离线有缓存、失败。“尚未索引”不能显示成“没有链接”。

## 面板

- **Item Pane → References / Citations**：出链与入链各分 Papers（论文 Raw / Canvas 之间）与 Notes（其余来源或目标）两组，带单元原文、次数和目标定位（[UNICONNECTION.md §4.2](UNICONNECTION.md#42-obsidian-paper-pane)）；提供商书目归 Bibliography。`-@` 写出的 `nocite` 链接（[UNICONNECTION.md §1](UNICONNECTION.md#1-链接角色模型)）不进任何列表。
- **UniZero Backlinks**：跟随最后激活的 Vault 笔记（点侧栏或设置不清空目标）。UniZero 链接与 Obsidian 已解析的原生链接（wikilink、嵌入、Markdown、属性）并列显示；Zotero 文档中的 wikilink 不读取。笔记无 UID 时说明原因，只隐藏 UniZero 链接，不误报零入链。打开的是 Zotero 附件时，改为显示其所属论文的入链。
- **UniZero Outgoing links**：Backlinks 的正向对应，跟随同一文档，用来取代 Obsidian 自带的出链面板。UniZero 出链取自该文档自身的索引记录（笔记本身无需 UID），原生出链取自 Obsidian 缓存；按目标分 Papers / Notes / Unresolved 三组，指向同一笔记的 UniZero 与原生链接合为一组。UID 缺失、重复或属于其他 Vault 时列入 Unresolved 并说明原因，不挑选候选。Unlinked mentions 默认折叠，展开后才把其他笔记的标题与别名匹配到本笔记；同名笔记各列一组，`Link` 由用户明确选择目标并在需要时为目标写入 UID。打开的是 Zotero 附件时，只列出其 UniZero 出链。
- 视图不做扫描、桥接请求或缓存决策，这些归共享应用层和适配器。

## 边界

- 桥接只提供 Zotero 目录、元数据和本地文件信息，不持有 Vault 索引，不修改 Obsidian 文档。新能力通过 ping capability 宣告，语义破坏才提升 `BRIDGE_API_VERSION`。
- 链接功能不涉及运行时 `/api/v1`。
- 不做：把 Zotero storage 挂成 Vault、向原生反链或关系图注入自定义 URI、书目写回或导入、索引 PDF 内链接和 Zotero 富文本笔记、`![](…)` 段落嵌入与悬停预览、Vault Canvas 的 UID 目标与卡片级 URI。
- **依赖 Obsidian 内部行为（按 1.15 源码核对）**：补全中选中当前项和程序化打开下一级用了未公开接口，缺失时退回到打字后才弹出；Live Preview 的点击按 `onEditorClick` 判断并截断事件，否则 Obsidian 会把 `unizero://` 交给操作系统。升级 Obsidian 后先复查这两处。

## 宿主验收记录

只记两类须在真实 Vault 中确认的项：从未在宿主中运行过的功能，以及修复后尚未复验的问题。改动界面后的常规手动检查不记在这里；某项确认通过后直接删除。

- **多 Markdown 附件**：11-07 只出现一个候选，已修复，需配合新版 add-on 复验。
- **标题与块定位**：定位本身尚未在宿主中确认，含无空格行尾 ID `text^1231312`。测法：在目标 Markdown 写 `用于定位的段落。 ^test-block`，再选 `^test-block`；“No block IDs in this file” 只表示文件里没有显式块 ID。
- **Zotero Canvas**：Canvas 内定位与卡片聚焦提示从未在宿主中运行。
- **Vault 笔记推送到 Zotero**：`POST /vault-mentions` 与 Zotero Uniconnection 中的 Vault 笔记、经 `obsidian://unizero?…&file=` 回到 Obsidian 的行与 Canvas 卡片定位，尚未完整复验。11-27 用 `path=` 时 Obsidian 报 “Vault not found”（`path` 被 Obsidian 当作绝对路径选 Vault），已改为 `file=`，需配合新版 add-on 与插件复验。
- **UniZero Outgoing links**：面板从未在宿主中运行。需确认：随笔记切换刷新；论文标题加载；原生未解析链接点击后按 Obsidian 行为打开；Unlinked mentions 的 `Link` 写入正确位置并为目标分配 UID。
- **`nocite` 渲染**：阅读视图与 Canvas 卡片中的灰色虚线框依赖 Obsidian 把链接 title 输出为 `title` 或 `aria-label`，未在宿主中确认；Live Preview 由插件自行标记。`-@` 补全（含 `[](-@…)` 与继续到标题/块）也未在宿主中运行。
