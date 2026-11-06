# UniZero 统一链接与反向引用：设计及施工交接

日期：2026-11-05。

本文保留已确认的设计与施工约束；当前实现和真实宿主验收进度见顶部状态及第 15 节。施工遵守 [仓库规则](../AGENTS.md)，当前使用说明见 [插件说明](../apps/obsidian-plugin/README.md)。

| 部分 | 状态 |
| --- | --- |
| 标准 Markdown 链接、移除自定义引用外观设置 | 已实现；阅读模式保留 Markdown 标签格式并已验证点击；其余宿主组合见第 15 节 |
| Vault 文档复用现有 UID，改名和移动不改链接 | 已实现；真实 Vault 已验证改名和重建；离线改名与文件夹移动待宿主验收 |
| 标题或块定位失效时退回打开文件 | 已实现；真实 Vault 已验证标题失效回退；Raw 改用 Obsidian 原生打开后的定位待宿主验收 |
| Vault 与 Zotero 两地文件的链接索引 | 已实现共享索引及只读分页目录；新 Zotero 安装的端到端覆盖待验收 |
| Item Pane 的 Links 页和文档侧 UniZero Backlinks | 已实现；真实 Vault 已验证 Backlinks 随 UID 显示来源 |
| URI 具体字段、索引刷新方式、迁移流程 | 已实现严格解析、可取消刷新、预览与恢复；真实 Vault 已验证迁移和恢复 |

## 1. 已确认的产品决策

1. `@` 保留为快速搜索和插入入口。选择 Zotero 论文后，默认写入 `[author, year](unizero://paper/...)`。
2. 链接文字是保存在文档里的普通 Markdown 内容，用户可以自由更改。以后修改 Zotero 作者、年份、标题，不自动覆盖已有链接文字。
3. 使用普通 Markdown 链接外观，移除设置界面的 Citation label 和 Citation style。保留 UniZero 的目标解析、点击、右键菜单，以及后续定位能力。
4. 不引入 `[[@...]]`，不占用 Obsidian 原生 `[[...]]` 的解析和文件身份。
5. 已有裸 `@libraryID/itemKey` 系列通过显式的 Transition 迁移，不在打开文档时自动改写（0.11.0 之后不再可读，见第 9 节）。
6. Zotero Item 身份继续使用 `libraryID + itemKey`。Vault 文档使用 `vaultID + UID`，复用用户已有的 UID，例如 `20260728102240`。
7. 文档改名、同一 Vault 内移动时 UID 不变，已有链接不需要修改。文件路径只参与本机解析，不是持久身份。
8. 标题或内容修改后，先尝试原定位。只要文件身份仍能解析，定位失效就打开文件并轻提示；不把整条链接判为失效，不猜相似标题或段落。
9. Zotero 文件引用 Zotero Item，与 Vault 文件引用 Zotero Item 使用同一个目标解析和索引模型。
10. Item Pane 原来的 Vault 页改为 Links，区分 Vault 和 Zotero 两种来源。
11. 增加跟随当前 Vault 文档的 UniZero Backlinks，展示哪些 Zotero 文件引用了该文档；同一索引也支持展示 UniZero 格式的 Vault 来源。
12. Zotero Markdown → Vault 和 UniZero Vault → Vault 共用文档搜索、目标解析和反向查询。来源读取及变更监听分别适配。

这里的“引用”指文档中实际写出的链接，不等同于论文书目中的 References、Citations，也不从标题相似度推断链接。

## 2. 原施工基线（保留用于交接）

先读 [插件说明](../apps/obsidian-plugin/README.md)，再读下列入口。

| 位置 | 当前行为及施工意义 |
| --- | --- |
| [citation.ts](../apps/obsidian-plugin/src/citation.ts) | 解析裸 `@`，目前支持 Item、Raw、PDF 和 `.pdf:15`；需增加新 URI 的纯解析与序列化 |
| [suggest.ts](../apps/obsidian-plugin/src/suggest.ts) | `@` 搜索 Zotero，选中后目前写入裸 `@`；需改为标准 Markdown 链接 |
| [render.ts](../apps/obsidian-plugin/src/render.ts) | 阅读模式与实时预览分别生成自定义引用组件，主动避开已有链接；新链接不能直接套用原替换逻辑 |
| [pill.ts](../apps/obsidian-plugin/src/pill.ts) | 目前管理动态引用文字、外观、点击和右键；迁移后保留必要行为，退出自定义外观体系 |
| [settings.ts](../apps/obsidian-plugin/src/settings.ts) | 现有引用文字和外观设置的定义及界面 |
| [vaultIndex.ts](../apps/obsidian-plugin/src/vaultIndex.ts) | 只索引 Vault 内 Markdown、Canvas，明确排除外部文件；这是 Zotero 文件能渲染但不计入引用列表的原因 |
| [detailView.ts](../apps/obsidian-plugin/src/detailView.ts) | 当前 Paper Pane 的 Vault 页按来源文件展示引用及跳转 |
| [main.ts](../apps/obsidian-plugin/src/main.ts) | 现有文件创建、修改、删除、改名监听及活动 Markdown 视图记录 |
| [actions.ts](../apps/obsidian-plugin/src/actions.ts) | Raw、Canvas 当前交给系统文件处理程序，PDF 交给 Zotero；不能据此声称已支持 Raw 标题或块定位 |
| [bridge.ts](../apps/obsidian-plugin/src/bridge.ts) | 插件侧桥接客户端；需能力协商，不与运行时 API 混用 |
| [服务端桥接](../apps/zotero-addon/src/server/bridge.ts) | 本地只读数据及既有附件动作的入口 |
| [桥接载荷](../apps/zotero-addon/src/server/bridgePayloads.ts) | `/artifacts` 可列出单个 Item 的 PDF 和 UniZero 生成附件；尚不是完整链接来源目录 |
| [历史 Markdown URL 注册](../apps/zotero-addon/src/zotero/markdownLinkRegistry.ts) | 仍有已有 Obsidian URL 与 UID 兼容行为，不能顺手替换或删除 |

遵守 [桥接边界](ARCHITECTURE.md#bridge-contract) 和 [兼容状态清单](LEGACY_SUPPORT.md)。此功能的文档链接索引不与书目关系索引合并。

## 3. 范围

### 本轮目标

- 标准 Markdown UniZero 链接的插入、解析、显示、点击、右键和索引。
- Item、PDF 页码、Raw 标题及已有块 ID 的定位。
- Vault Markdown 的 UID 定位、标题和已有块 ID 定位。
- Vault Markdown、Canvas 文本，以及 Zotero 下声明可读的 Markdown、Canvas 文本作为链接来源。
- 四种方向：Vault → Zotero、Zotero → Zotero、Zotero → Vault、Vault → Vault。
- Links、UniZero Backlinks、旧 `@` 的显式迁移和过渡兼容。

### 不随本轮扩展

- 不把 Zotero storage 复制、挂载成 Vault 来获得原生双链。
- 不接管原生 `[[...]]`，不把自定义 URI 注入原生反链或关系图，不依赖全局修改原生链接解析器。
- 不实现书目信息写回、探索结果导入、文献关系抓取或自动转换。
- 不修改旧 Home、Board、Graph。
- 不索引 PDF 内部的链接和 Zotero 原生富文本笔记。
- 不把 Raw Backup、表格摘要、References JSON 等派生输出重复当作引用来源。
- 不承诺 `![](...)` 的段落嵌入、实时内容同步或全文悬停预览；这些可以后续复用目标解析器实现。
- Canvas 本轮作为来源；Vault Canvas 的稳定 UID 目标及卡片级 URI 另行设计。

## 4. URI 与 Markdown 格式

以下格式现已实现；真实宿主覆盖范围见第 15 节。

### Zotero 目标

| 行为 | 规范 URI |
| --- | --- |
| 打开 Item Pane | `unizero://paper/1/2BJFPCUL` |
| 打开默认 PDF | `unizero://paper/1/2BJFPCUL.pdf` |
| 打开 PDF 第 15 个物理页 | `unizero://paper/1/2BJFPCUL.pdf?page=15` |
| 打开默认 Raw | `unizero://paper/1/2BJFPCUL.md` |
| Raw 标题 | `unizero://paper/1/2BJFPCUL.md#Methods` |
| Raw 块 ID | `unizero://paper/1/2BJFPCUL.md#%5Eresult-01` |

正文示例：

```markdown
[Smith, 2024](unizero://paper/1/2BJFPCUL)
[查看原文第 15 页](unizero://paper/1/2BJFPCUL.pdf?page=15)
[这篇论文的方法](unizero://paper/1/2BJFPCUL.md#Methods)
```

- `.pdf?page=N` 为规范输出，页码是正整数物理页，不是印刷页标签。不新增 `.pdf.N` 这一套持久语法。
- `.md#标题`、`.md#^块ID` 为逻辑写法；序列化时编码 URL，规范示例中的 `^` 写为 `%5E`，不使用 `{}`。
- 同一 Item 有多个 PDF 或 Raw 时，使用可选查询参数 `attachment=<attachmentKey>` 精确指向附件。例如 `.pdf?attachment=ABCD1234&page=15`。
- 无 `attachment` 的 URI 表示 Item 的默认文件，沿用并集中管理现有默认文件选择策略；显式指定的附件不存在时不得静默改开其他附件。
- 附件 key 始终受所属 `libraryID + itemKey` 约束，禁止跨库或跨 Item 猜测。
- Item 级 Links 将该 Item 自身及其文件、页码、标题和块的入链汇总，具体定位保留在每条记录上。

### Vault 文档目标

```markdown
[方法总结](unizero://note/vault-example/20260728102240)
[实验设计](unizero://note/vault-example/20260728102240#实验设计)
[关键结论](unizero://note/vault-example/20260728102240#%5Eresult-01)
```

`vault-example` 只是文档示例，不是真实 Vault 标识。实际写出前必须取得稳定的逻辑 `vaultID`。Vault 文档标题与路径不写进身份部分。

URI 的路径段、查询值和片段分别编码，解析时只解码一次。拒绝不合法身份、冲突参数、非法页码和不支持的定位组合；未知版本或目标类型不得静默降格为另一种目标。

### 协议路由

- 先保证安装 UniZero 的 Obsidian 内，在 Vault 文档和 Zotero 外部文档中点击上述链接都能由插件处理。
- Markdown 语法标准，不代表操作系统已注册 `unizero://`。本轮不得声称其他应用或未安装插件的 Obsidian 也能直接打开。
- 在阅读模式和实时预览中，仅处理经过严格解析的 UniZero 链接；保留链接文字已有的 Markdown 显示。不把原生链接整体替换成自定义引用组件。
- 不接管无关的普通链接、`zotero://` 或 `obsidian://`。
- 如需要从应用外唤起 Obsidian，可另外提供 `obsidian://unizero?...` 传输入口，内部仍解析同一个规范目标；不把两种传输地址混成两个文档身份。
- 自定义协议的系统级注册不是实现此方案的前提。

## 5. UID 与文档身份

### 复用现有体系

用户已有类似 `20260728102240` 的 UID。实施前核对实际存放位置和字段名；不能假定全部文件都使用下面的示例，也不能批量生成新 ID 覆盖旧体系。

```yaml
---
uid: "20260728102240"
---
```

- 提供 UID 属性名配置，默认建议 `uid`。如果现有 UID 在文件名或其他位置，增加明确的可配置读取方式，不自动从任意 14 位数字猜身份。
- UID 按不透明字符串处理，不强制为日期，不从它计算创建时间。读取 YAML 数值时仅对可无损转换的值做兼容；不得丢前导零或精度。
- 已有 UID 不变。没有 UID 的文档，在选择它作为稳定链接目标时提示补充身份，允许使用现有 UID 生成流程；不得为一次渲染隐式修改 frontmatter。
- 如提供“分配 UID”，必须是明确的用户动作并检测冲突。不要引入与用户现有生成器竞争的后台生成器。
- 内容相同不是同一文档的依据。复制文件造成 UID 重复时，展示候选冲突，等待用户修复；不按路径或打开顺序选择。

### Vault 身份与映射

- 生成一次逻辑 `vaultID`，作为插件的可同步持久配置保存。每台电脑把这个标识映射到本机打开的 Vault；不以绝对路径或 Vault 显示名作为持久身份。
- 同一 Vault 在不同电脑上应保留同一个逻辑 ID。独立复制成新 Vault 时应有显式“作为新 Vault”操作，不静默重置已有 ID。
- 首轮自动解析范围是当前 Vault。其他 Vault 的链接显示目标 Vault 信息；未注册或未打开时提示需要打开目标 Vault，不扫描磁盘寻找。
- `vaultID + UID → 当前路径` 为可重建索引，缓存失效可以扫描重建。具体路径不承担权威身份。
- 初次加载和插件重新启用时扫描；创建、修改、删除、文件和文件夹改名时增量更新。离线改名和同步后仍需能重建。
- 同一 Vault 内改名和移动只更新映射，不改写引用文档。
- 跨 Vault 移动不是普通改名：需要显式身份迁移或旧身份到新身份的重定向。本轮至少识别原目标缺失并提示，不声称自动跨 Vault 保持链接。
- 用户主动修改 UID 属于身份改变，不自动按标题把旧链接接到新文件；保留显式重定向的扩展位置。

### 文件定位失效的已确认规则

| 状态 | 点击行为 |
| --- | --- |
| 文件可解析，标题或块仍存在 | 打开文件并定位 |
| 文件可解析，标题已改名或删除 | 打开文件，轻提示原标题定位不可用 |
| 文件可解析，块 ID 已删除或改变 | 打开文件，轻提示原块定位不可用 |
| 内容改变，但块 ID 保留 | 定位到该块的当前内容 |
| 标题有多个无法确定的候选 | 打开文件并提示定位歧义，不随机跳转 |
| UID 重复 | 展示身份冲突，不任意打开某个文件 |
| 文件或显式指定附件不可用 | 提示文件缺失、未同步或目标不可用，不创建同名文件 |

不自动改写失效锚点，不根据相似内容偷偷重建引用。面板中可以标记“文件可用，定位失效”，并保留原 URI 供修复。

## 6. 搜索、选择与打开

### `@` 插入

- 保留现有作者、标题、年份等自由文本搜索，默认搜索 Zotero。
- 搜索器提供明确的 Zotero / Vault 来源切换；Vault 目标可按标题、路径、UID 搜索。不要在同名结果中静默选择。
- 默认确认 Zotero 结果时插入 `[author, year](...)`。沿用现有作者简写逻辑处理多作者；缺作者或年份时用可读的标题等回退文字，不写 `undefined`。
- Vault 目标默认使用当前文档标题作为链接文字，URI 使用稳定 UID。
- 支持在选择阶段继续选择 PDF、Raw、页码、标题和已有块 ID；可用 `#`、`^` 作为选择器内的快捷入口，而不是监听所有普通正文中的这些字符。
- 已插入链接可通过右键或命令重新选择定位，不要求用户手工编辑 URL。
- 标签生成器必须正确转义 Markdown 方括号等特殊字符。保留普通链接文字的人工编辑，不在后台重新格式化。
- 侧栏插入、搜索弹窗、拖放等所有新插入入口使用同一序列化器，不留下继续写裸 `@` 的入口。

### 深层定位

- Vault 文档可以复用其元数据中的标题、块和原生文件打开能力，但目标身份仍由 UID 解析。
- Zotero Raw 需要独立、可重建的标题和块索引，读取声明可用的本地文件；无本地文件时不自动转换或触发同步下载。
- 已有块 ID 可以直接选择；没有块 ID 时，不能把当前行号当作持久块 ID。
- “为段落创建块 ID”若实现，必须是显式编辑动作，通过编辑器写入并保持撤销能力；不通过 GET 或新增隐式桥接写入完成。
- Raw 必须有可按标题和块定位的打开适配。仅调用系统 `openPath` 不能算完成此项。
- 优先验证现有外部 Markdown 阅读编辑入口能否提供稳定定位；若需要插件自己的 Raw 视图，保留对原附件的打开、图片相对路径解析和用户编辑能力，不写出第二份 Raw。
- 若宿主不支持某次定位，按已确认规则退回打开原文件并提示，不跳入错误文档。手动验收前不得声称已达到完整标题或块体验。

## 7. 两地来源与统一索引

### 概念模型

实现可以调整模块和类型名，但必须保留以下信息和方向。

```text
SourceDocument
  vault: vaultID + UID（若存在）；当前路径仅用于读取与回跳
  zotero: libraryID + itemKey + attachmentKey；本地路径仅用于读取与回跳

LinkTarget
  paper: libraryID + itemKey + action + optional attachmentKey
  note: vaultID + UID
  location: optional page / heading / blockID

LinkOccurrence
  source identity
  source location: line/column, optional Canvas nodeID
  target identity + optional location
  original URI or legacy token
  surrounding text
```

- 来源与目标分别建模；不能因为 A 引用了 B 就认为 B 也引用了 A。
- 同一文档的每个出现位置保留，按文件或 Item 聚合时另算数量，不丢失定位信息。
- Vault 来源没有 UID 时，仍可按当前路径索引其出链和来源位置；只有将它选为稳定目标时才要求 UID。文件改名时更新该来源记录。
- 同一 Zotero 文件即使被 Obsidian 以外部文件形式打开，也只登记一次来源，归属 Zotero，不重复当作 Vault 文件。
- 两种语法解析成相同目标。一次 Markdown 链接的 URI 或文字内部不得再次匹配裸 `@` 而重复计数。
- 使用 Markdown 结构解析而非全文正则替换；排除代码、示例、注释等非链接区域。Markdown 内联链接、引用式链接和裸旧 `@` 的支持范围要有明确测试。
- Canvas 读取文本卡片和现有支持的标签文字；文件卡片引用的 Markdown 由文件本身索引，不把嵌入显示重复计数。不索引任意 JSON 字段里的 URL。
- 原生 `[[...]]` 保持 Obsidian 原生行为。本轮 UniZero Backlinks 默认统计 UniZero URI 和旧 `@`，不假装已经汇总原生 Backlinks。

### Zotero 来源清单与覆盖

现有 `/artifacts` 是单 Item 的生成附件清单，不能仅依靠它完成全库来源发现。建议给桥接增加分页的只读来源目录，例如 `GET /unizero/v1/link-sources`，用新的 ping capability 宣告；具体载荷应随施工定义和测试。

目录至少表达：

- 库身份、父 Item key、附件 key、显示标题、文件格式及用途。
- 本地文件路径或明确的文件不可用状态；路径只供受控本机读取，不写进持久 URI。
- 可用于检测更新的版本或时间信息；不足以检测文件内容修改时由读取侧补充文件状态和内容摘要。
- 分页与扫描完成信息；不能把拉取中断当成完整清单。

目录范围包括 Raw、Canvas 和明确声明为可读来源的用户 Markdown、Canvas 附件。非 UniZero 附件可以只读索引，不因此获得 UniZero 管理所有权。Raw Backup、历史派生副本及机器生成摘要按用途排除，避免重复引用。

- 不直接遍历猜测 Zotero storage，也不让 Obsidian 自己复制 Zotero 附件识别和所有权规则。
- 必须覆盖配置库范围内未打开的来源文件。打开过才索引只能叫部分覆盖。
- 初次建立来源目录由启用此功能或显式重建发起。后台增量刷新只读本地桥接和文件，不启动提供商查询、运行时或转换。
- Obsidian 的 Vault 事件不能覆盖所有外部文件修改；Zotero 附件目录更新与外部文件内容更新都需考虑。没有可靠外部文件事件时，用有界、可取消的文件状态检查及手动刷新补足，并在真实宿主验证。
- 文件更换、附件改名、文件路径变化、移入废纸篓及恢复均更新对应记录。
- 全量重建、增量读取使用代次或修订号，防止旧异步结果覆盖新结果。卸载后不得重新写入内存索引。
- 只有成功读取且确认为空的内容，才移除该来源旧出链；文件缺失、读失败或桥接离线保留上次记录并标记过期。
- 只有完整成功的目录扫描才据清单移除已删除来源，分页中断不得清空剩余来源。
- 缓存是可删除、可重建的派生状态，保存版本并失效重建；不回写书目关系缓存、Paper catalog 或附件元数据。
- 窗口间避免重复全库扫描；共享索引和刷新任务，视图只订阅，不自行各扫一遍。

索引状态至少区分：未建立、更新中、当前范围扫描完成、部分覆盖、离线且有缓存、失败。展示扫描范围、不可用来源数及最后成功时间，不能把“尚未索引”显示成“没有引用”。

## 8. 右侧面板

### Item Pane

- 保留现有论文元数据、Raw、Canvas、PDF 动作、References、Citations、Relation。
- 将 Vault 页改为 Links，表示指向该 Item 及其文件的入链。
- 来源按 Vault / Zotero 分组。Zotero 来源再按父 Item 和附件分组，Vault 来源按文档分组。
- 显示来源标题、当前路径或附件用途、上下文、出现次数和目标定位，例如 PDF 页码、Raw 标题或块。
- 点击来源 Item 打开相应 Item Pane；点击具体上下文回到来源文件的引用位置。跳回位置失效也退回打开来源文件。
- 与提供商 Citations 保持独立，禁止混合统计。
- 保留已有视图和命令 ID；界面改称 Item Pane 不要求重命名所有持久标识。

### UniZero Backlinks

- 新增独立视图及打开命令，跟随用户当前查看的 Vault Markdown 文档，而不是某个选中的 Zotero Item。
- 以当前文档 `vaultID + UID` 查询入链，默认突出 Zotero 来源，也能显示 UniZero URI 的 Vault 来源。
- 当前文件无 UID 时显示“尚无稳定身份”及设置身份的入口，不误报零入链；不自动写 frontmatter。
- 显示来源 Item、附件类型、上下文、目标标题或块，并支持打开来源 Item 或来源文件。
- 文档改名后跟随 UID 更新标题，引用数量不因路径改变而归零。
- 点击侧栏、设置或其他非文档视图不清空当前文档目标。多标签或多窗口依据用户最后激活的合格文档更新，并清理各窗口监听。
- 当前打开的是 Zotero 外部文件时，不误当成 Vault 文档；可以显示“这是 Zotero 附件”并提供切到所属 Item 的入口。
- 索引覆盖状态与列表一同可见，尤其区分真实零入链和未完成扫描。

视图不负责文件扫描、桥接请求或缓存策略；这些属于共享应用层或适配器。

## 9. 旧引用的 Transition

0.11.0 提供显式的 Transition 命令：预览当前文档、Vault 或选定 Zotero 文档，确认后把旧引用改写为 Markdown 链接，并保存原文日志以便恢复。元数据无法解析的引用保持原文。

```text
@1/2BJFPCUL          → [Smith, 2024](unizero://paper/1/2BJFPCUL)
@1/2BJFPCUL.md       → [Smith, 2024](unizero://paper/1/2BJFPCUL.md)
@1/2BJFPCUL.pdf:15   → [Smith, 2024, p. 15](unizero://paper/1/2BJFPCUL.pdf?page=15)
```

0.11.0 之后，裸 `@libraryID/itemKey` 的读取、Transition 命令和 `pillLabel`、`pillStyle` 兼容分支均已移除；旧引用只作为普通文本。

## 10. 模块与边界建议

- 在 [插件源目录](../apps/obsidian-plugin/src/) 内拆分纯 URI 解析、文档身份解析、链接索引、打开调度及视图适配。按实际实现创建模块，不先搭空目录。
- 扩展或替换现有 `vaultIndex` 为统一文档链接索引，但保留现有 Library 引用计数、来源跳转等消费者所需行为。
- 两类文档来源通过适配器提供读取、修订、定位和监听；两类目标通过解析器提供身份查找、标题或块选择和打开。
- 桥接仅提供 Zotero 目录、元数据和本地文件信息，不持有 Vault UID 索引，也不负责修改 Obsidian 文档。
- Zotero API 和附件读取身份规则留在 [Zotero 适配层](../apps/zotero-addon/src/zotero/)。不能在插件硬编码生成附件标题来认 Raw。
- 新桥接能力属于 Zotero ↔ Obsidian 边界；兼容新增通过 capability 协商，字段语义破坏才按现有规则升级桥接版本。
- 此方案不需要改运行时 `/api/v1`，也不应仅为链接功能修改 [运行时契约](../packages/contracts/http/v1.schema.json)。
- 不把文件索引变成 Zotero 权威书目数据；库身份、附件身份和用户手写 UID 的所有权保持明确。
- 不改现有 release 版本；需要发布时使用仓库 release 命令。

## 11. 建议施工顺序

各阶段可拆提交，但最终验收以完整范围为准，不把中间阶段描述为全部完成。

1. **协议与纯逻辑。** 固定 URI、目标与来源模型、编码、附件选择、UID 冲突和定位回退规则；建立有实际边界价值的测试。
2. **标准链接。** 所有插入入口改为 Markdown 链接，阅读模式及实时预览支持点击与右键，移除外观设置，保留旧 `@` 兼容。
3. **Vault 身份。** 接入实际 UID 体系和逻辑 Vault 身份，支持改名、移动、重建及冲突；完成 Vault 目标选择与打开。
4. **深层定位。** PDF 页码、Vault 标题和块、Raw 标题和块索引与打开；按文件级回退规则验收。
5. **双来源索引。** 增加只读来源目录及能力协商，覆盖未打开的 Zotero 文件和外部修改，维护覆盖状态及过期记录。
6. **两个面板。** Item Pane → Links 分来源，增加跟随当前文档的 UniZero Backlinks；复核旧 Library 计数与跳转没有退化。
7. **Transition。** 预览、选范围、修订校验、可恢复写入、幂等、索引更新及兼容清单。
8. **真实宿主验收与文档。** 更新当前行为说明，移除已落地路线条目，保留本设计并更新顶部状态。

施工前只需核实实际 UID 的字段或存放规则、Zotero 外部文件的真实打开编辑方式和现有工作区状态；其余已确认产品决策不需要重新讨论。

## 12. 验收与测试

### 自动验证重点

- URI 编解码往返；非 ASCII 标题、方括号、空格、百分号、`#`、`^`；非法身份和页码；指定附件不会误选别的附件。
- UID 同库唯一性、跨 Vault 区分、改名、文件夹移动、离线重建、复制冲突、无 UID 来源和目标的不同处理。
- 标题或块变化时目标仍解析为同一文档，定位失效退回文件；块内容变化但 ID 未变时继续定位。
- 新旧语法同一索引、代码及已有链接不重复识别、Markdown 引用式链接、Canvas 支持字段及重复来源去重。
- Zotero 来源分页中断、文件不可用、桥接离线、旧异步结果、卸载、删除与恢复，不把失败当空结果。
- 三个旧插入入口以上的统一输出、链接文字保持用户修改、原生双链及非 UniZero 链接不被接管。
- 迁移预览后文件变化、失败恢复、重复执行、未解析 Item、代码跳过、Canvas 结构保持。
- 来源目录包含库范围和附件身份、排除备份与派生摘要、GET 无写入，以及新能力缺失时明确报告覆盖受限。

按变更组件执行其 `npm run check`、`npm test`、`npm run build`。桥接修改至少验证 Obsidian 插件与 Zotero add-on；若触及 MCP 消费的现有载荷，还要运行 MCP 的同组检查。运行时未变更就不为本任务启动转换或运行真实运行时测试。

### 必须进行的真实宿主验证

1. 在真实 Vault 和运行中的 Zotero 中，阅读模式、实时预览、外部 Markdown 和 Canvas 文本中的链接可点击、右键可用，编辑文字不被覆盖。
2. Vault → Zotero、Zotero → Zotero、Zotero → Vault、Vault → Vault 四方向均能插入、打开并在对应面板显示入链。
3. 一个未打开过的 Zotero 文件仍出现在入链中；外部编辑器保存后能刷新，桥接断开时保留有状态标识的缓存。
4. Vault 文件反复改名、移动、插件关闭后改名再启动，UID 链接继续打开同一文件，面板不丢引用。
5. 修改标题或删除块 ID 后，链接打开文件并提示定位失效；保留块 ID 只改内容后仍定位当前块。
6. PDF 页码、主文件与补充文件、多个 Raw 的选择正确；显式附件缺失不会打开另一个文件。
7. 分组、出现次数、来源 Item 和附件、跳回位置正确；同一外部附件没有重复计算。
8. 两个右侧面板可独立使用；切换文档后 Backlinks 跟随，点击侧栏不丢目标；多窗口和卸载后无残留监听。
9. （Transition 已移除，不再验收。）
10. 渲染、索引、打开面板不会启动提供商请求、转换、创建附件或给文件自动添加 UID。

无法完成的宿主验证必须逐项记录为未验证，不用单元测试通过代替真实宿主结果。

## 13. 施工完成时更新的文档

- [插件说明](../apps/obsidian-plugin/README.md)：新链接、UID 设置、来源范围、面板、迁移及降级行为。
- [架构说明](ARCHITECTURE.md)：只在新桥接来源目录和依赖边界实际落地后更新当前行为。
- [项目结构](PROJECT_STRUCTURE.md)：补入实际新增且承担职责的模块。
- [兼容状态清单](LEGACY_SUPPORT.md)：记录旧 `@` 和旧外观配置的兼容读取及退役条件。
- [路线图](ROADMAP.md)：已落地内容移除，未完成的人工验证单独记录。
- 本文顶部状态表：标明已实现部分、剩余部分和真实宿主验证结果。

## 14. 官方参考

- [Obsidian 内部链接](https://obsidian.md/help/links)：标题、块 ID 与显示文字的语义参考；自定义 URI 不会因此自动获得原生索引。
- [Obsidian URI](https://obsidian.md/help/Extending%2BObsidian/Obsidian%2BURI)：跨应用打开及经过编码的标题、块定位参考。
- [Obsidian API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)：施工时同时核对本组件安装版本的类型定义，不凭最新文档假定已安装宿主支持全部 API。

## 15. 本次施工与宿主验收记录

施工日期：2026-11-05。原方案各节保留其设计语气，当前进度以本节为准。

### 已落地

- 严格 URI 编解码、标准 Markdown 插入、原始标签保留、旧引用普通链接显示。
- 复用实际模板的 `uid` 字段；逻辑 Vault 身份、显式新 Vault 操作、可配置文件名读取、复制冲突检测。
- Vault、Raw 的标题和块解析及文件级回退；Raw 由 Obsidian 原生编辑器打开（`file:<路径>`）。
- 共享文档索引、Vault 事件适配、只读 Zotero 来源目录、附件限定解析、可取消轮询、过期缓存与覆盖状态。
- Links 页、跟随文档的 Backlinks、当前文档无 UID 或外部附件的明确状态。
- 当前文档、Vault 和选定 Zotero 文档的 Transition 预览；修订校验、编辑事务、原文日志、匹配恢复、Canvas 局部改写。
- 桥接新增能力为 `link-sources`、`link-targets`，不修改运行时契约、发布版本或旧 Home/Board/Graph。

### 本次真实宿主结果

Obsidian 1.15.0，真实 Vault 内使用临时测试文档；实际 Zotero 仍为旧安装，未提供新增目录和目标解析能力。

| 原验收项 | 本次结果 |
| --- | --- |
| 1. 阅读模式、实时预览、外部 Markdown、Canvas 的点击与右键 | 部分通过：真实阅读模式保留加粗标签，鼠标点击打开 UID 目标；其余组合未验证 |
| 2. 四方向插入、打开和面板入链 | 部分通过：Vault → Vault 的索引、打开和 Backlinks 已验证；Vault → Item 的新旧语法同一索引已验证；完整四方向未验证 |
| 3. 未打开 Zotero 文件、外部修改与离线缓存 | 未进行新版桥接的真实宿主验证；分页、失败保留、空读取及卸载由自动测试覆盖 |
| 4. 改名、移动、离线改名后重建 | 部分通过：真实文件改名和显式重建继续解析同一 UID；文件夹移动和离线改名未验证 |
| 5. 标题失效、块失效与块内容更新 | 部分通过：真实 Vault 标题更改后退回同一文件；其余组合未验证 |
| 6. PDF 页码、多 PDF/Raw 与显式附件缺失 | 新版 Zotero 端到端未验证；严格参数、限定附件和缺失不降格由自动测试覆盖 |
| 7. 分组、次数、来源 Item/附件与回跳 | 部分通过：真实 Vault 同一来源计数和 Backlinks 上下文；Zotero 来源分组和回跳未验证 |
| 8. 双面板、多窗口与卸载 | 部分通过：Backlinks 独立打开、切侧栏保留目标、插件重载及 Raw 外部来源提示；多窗口交互与监听计数未验证 |
| 9. Transition 预览、应用、恢复和编辑保护 | 真实小范围通过：预览后编辑被跳过；正常迁移保存原文并成功恢复；原有 Markdown 标签保留。Zotero/Canvas 批量流程未进行真实宿主验证 |
| 10. 无隐式提供商请求、转换或分配 UID | 代码路径及自动测试已检查；真实 Vault 的打开、渲染和建索引未添加 UID；未对全部宿主场景进行网络和附件变更监测 |

### 施工后修复（尚未经真实 Obsidian 验证）

上述宿主结果早于以下修复。它们已由自动测试和真实 Chromium 中的 CodeMirror 验证，仍须在真实宿主复验：

- 以 wikilink 或注释开头的行不再被解析成缩进代码块，其中的链接、旧引用和块定位恢复；含 wikilink 的标题值保留 wikilink 原文。
- `@` 搜索增加逐级补全（`linkCompletion.ts`、`targetSuggest.ts`）：`Tab` 或 `Shift+↵` 选择 Raw/PDF，`#` 和 `^` 直接进入标题和块；光标在链接地址内时输入也会触发同样的补全。只列出已有块 ID，不代写块 ID。选中当前项和程序化打开下一级依赖 Obsidian 未公开的内部接口，已按 1.15 源码核对，缺失时退回到打字后才弹出。
- `@` 建议框移除 Locate 按钮并压缩为两行；标题候选显示 H1–H6 并按层级缩进。中文输入法写入的 `#`、`＃`、`^`、`＾`、`……` 由文本识别，效果与英文按键相同。Links 与 Backlinks 列表改为紧凑行：显示链接标签而非地址，路径和扫描详情放入悬停提示。
- 移除插件自带的 Raw 编辑器及其草稿；`.md` 链接用 Obsidian 原生编辑器打开并定位。
- Refresh links 只处理有变化的文件并分片让出主线程，整轮只通知一次；“Rebuild document links”仍全量解析。重启后未变化的 Zotero 文件不再重新解析。Item Pane 与 Backlinks 在未启用 Zotero 文档索引时明确提示并可直接启用。
- 实时预览中点击 UniZero 链接不再被 Obsidian 交给操作系统（Windows 曾提示为 `unizero` 链接寻找应用）；判断规则对齐 Obsidian 1.15 的 `onEditorClick`，并阻止事件到达其外层监听器。格式不合法的 `unizero://` 地址仍由 Obsidian 按外部链接处理。
- 阅读模式只解析含 `@` 的渲染块本身；编辑时不再随按键解析全文，含旧引用的文档在停顿 400 ms 后重扫；索引每个文件只解析一次。

### 保留的边界与后续验收

- Zotero 目录为显式启用；旧 add-on 缺少能力时展示部分覆盖，不能把它当作全库零引用。
- 外部 Canvas 在宿主缺少卡片定位能力时打开原文件并提示卡片 ID。
- 其他 Vault 提示打开匹配的逻辑 Vault，不扫描磁盘；跨 Vault 迁移与重定向未扩展。
- 真实新版 Zotero 的完整四方向、外部变更、附件恢复、多附件和多窗口验收仍开放；不得以本次自动测试替代。

临时测试文档已清理，测试使用的本机插件文件与设置已恢复；工作区保留实现及本机构建结果，未发布或更改版本。
