# 同步与文献数据源设计

> 中文设计文档，自包含。本文只保留**决策、不变量和尚未实现的设计**。
> 已实现行为的权威描述在 [ARCHITECTURE.md](ARCHITECTURE.md)，未完成工作清单在
> [ROADMAP.md](ROADMAP.md)，落地的类型以 `src/sync/types.ts` 和 `src/projects/types.ts`
> 为准——本文不再复制它们的声明。

## 状态

| 部分 | 状态 |
|---|---|
| typed document / namespace registry / backend-neutral engine | 已实现 |
| WebDAV backend、immutable pack、per-device manifest、本机 checkpoint | 已实现 |
| Login Manager 凭据、手动与定时同步 | 已实现 |
| `project.meta` / `project.board` / `project.board-node` / `project.board-edge` | 已实现 |
| 统一 Paper catalog、citation observation、merge/redirect（数据层） | 已实现 |
| `literature.*` namespace 同步（§4） | **未实现** |
| `settings.portable`（§5） | **未实现，连定义都还没有** |
| `LiteratureSource` 能力边界与本地 corpus（§6） | **未实现，且刻意不做** |
| Project 身份迁移与冲突审阅 UI | **未实现** |
| pack compaction / GC | **未实现，需要先设计** |

## 1. 为什么需要这一层

provider 结果昂贵但可重建；Project 与 Board 是用户主动创作、**不可重建**的状态。
把两者混在一起处理，要么让创作状态被当成缓存丢掉，要么让缓存获得它不配拥有的
权威性。因此这份设计要立的是两个互相独立的扩展点：

1. **文献数据源边界**——Home 不关心数据来自在线 provider 还是未来的本地 corpus；
2. **可同步状态边界**——功能模块不关心远端是 WebDAV、同步目录还是别的服务。

## 2. 核心决策

### 2.1 Zotero 继续是权威来源

bibliographic fields、annotations、collection membership 和原生 Related Items 由
Zotero 所有，走 Zotero Sync。UniZero 同步得到的 provider metadata 只能是候选、缓存
或探索数据；除非用户通过既有 Zotero mutation 流程确认，否则不能覆盖 Zotero item。

### 2.2 同步原料，不同步派生连接

References 是连接的可携带原料，每台设备各自建立 `UniConnection`：

```text
Zotero items + References cache → UniConnection build/ingest → relations / coupling / topology
```

自动 topology 不上传。否则会出现第二份权威图，以及 topology 与 shard 版本不一致
的问题。见 [UNICONNECTION.md](UNICONNECTION.md)。

### 2.3 本机目录不是同步协议

本机继续用 `<libraryID>/<itemKey>.json`，因为它适合 Zotero 进程内查找和 sweep。
远端保存的是带类型、版本和 subject 的同步文档，同步层负责两者之间的映射。因此
将来可以改变本机 shard envelope、或让库外论文拥有缓存，而不必改动传输接口。

### 2.4 WebDAV 只是 backend

WebDAV 负责列举、下载、条件写入和删除对象，**不理解**业务语义。schema migration、
冲突合并、dirty tracking 属于同步引擎和各 namespace。

### 2.5 本地 corpus 只是另一种文献数据源

它不是同步状态，也不是现有 shard 的放大版，而是可重新部署、带数据版本的只读数据
产品，通过 `paper-runtime` 的版本化 localhost API 暴露。装不装它，不应改变 Home
上层的数据形状。

### 2.6 身份与文档 ID 必须分离

- 同步对象的 `id` 标识一个需要版本控制的逻辑文档，创建后**永远不变**；
- 论文身份由 identifiers 与 Zotero binding 描述，可以随时被补全或合并；
- 后来补上 DOI、或发生 identifier merge 时，更新身份，**不动** `id`。

跨设备协议中一律使用 portable library scope（`ZoteroLibraryScope`），不写本机数字
`libraryID` 或 `collectionID`。落地的形状是 `PaperDocument` + `ZoteroPaperBinding`
（`src/projects/types.ts`），不是本文早期设想的 `PaperLocator` union。

## 3. 不变量

这些是同步层最容易被无意破坏的地方，改动同步相关代码前应逐条对照：

- cache 不创建 Zotero item，也不覆盖 Zotero bibliographic fields；
- 一条远端记录不能跨 library scope 导入；
- identifier mismatch 是 miss，不是"尽量匹配"；
- topology 永远可以从 Zotero + References 重建，所以它永远不进同步；
- 同步失败不阻断本机 References/Citations 的正常使用；
- secret 不进入同步 payload、typed document、checkpoint 或日志；
- 旧客户端遇到未知 schema 必须清楚失败，不能静默降级写坏远端；
- 冲突不能被当成成功——有些 WebDAV 服务不提供可用于强条件写入的 ETag，
  capability probe 必须识别这种情况，backend 可以退化为 revision 检查，但绝不能把
  precondition failure 报成写入成功。

一次正常 pull 的顺序（每一步都是前一步的前提）：等待本机 library 可用 → 拉取 typed
documents → 解析 portable scope 与 item key → 确认 Zotero item 存在 → 校验 subject
identifiers → migrate 与 merge → 原子写入 → 更新内存状态 → 保存 revision。

## 4. 未实现：Literature namespace 同步

下一批 namespace 是 `literature.paper`、`literature.observation` 与
`literature.paper-redirect`，之后才评估 References/Citations snapshot。

### 4.1 References 优先

它驱动现有 Relation、coupling 和 Graph；reference list 相对稳定；重新获取会触发大量
enrichment 请求；第二台设备导入后可以立即重建 topology。合并规则：

- subject identifiers 不匹配时**拒绝导入**；
- schema 未知且不能 migrate 时保留远端对象并报告不兼容；
- 完整 resolved 结果优先于不完整结果；
- 同一 provider 的较新成功结果优先；
- 不同 provider 的结果保留 provenance 后按既有 identity 规则 union；
- 匿名 edge 可以保留用于显示，但不能因此获得虚构 identity；
- imported shard 写完后必须调用该 library 的 `ingestItem` 或 invalidate/rebuild。

### 4.2 Citations 其次

它持续增长、分页可能很多，且不参与当前 topology。合并规则：

- 每个 provider 独立保存分页状态、total 和 fetched time；
- entries 按稳定论文 identity 去重；
- **新 total 不能证明旧 entries 已过期**；
- 不同 source 的 page cursor 不能互换；
- 展示"截至何时"的 provenance，不把 citation count 当成永恒事实。

本机 `Citations-v4` 已经保存有证据的空结果：至少一个 provider 明确返回 `empty`，
negative cache 才有效，有效期 24 小时；纯 provider failure 不会被固化成"0 Citations"。

### 4.3 时机与删除

第一版提供显式 `Sync now`、启动后延迟 pull、读取 miss 时的非阻塞 pull、写 shard 后的
debounce push，以及网络失败时继续使用本机状态。不依赖未验证的 Zotero 私有 sync hook。

第一版**不传播 cache 删除**。远端对象只有在对应 Zotero item 存在且 subject 校验通过
时才导入，所以陈旧 cache 不会复活 item。远端回收另见 ROADMAP 的 pack GC 条目。

## 5. 未实现：设置同步

插件设置不能作为一个整体上传。每个公开设置必须声明 portability，**没有声明的默认
`device`**：

| 类别 | 示例 | 行为 |
|---|---|---|
| `portable` | Graph 外观与 force 偏好、通用 UI 行为 | 可进入 `settings.portable` |
| `device` | Python path、server script、port、本机路径、进程启动策略 | 只留本机 |
| `secret` | Semantic Scholar API key、WebDAV password/token | 不进入普通同步 |

portable settings 按 **key** 合并，不是整份 latest-write-wins——否则两台设备各改一项
会互相覆盖。

Graph layout 默认不同步：它是可重建的显示状态，且坐标有效性依赖 layout version、
force signature 和 library scope。Board 坐标则相反，它表达用户主动组织的意义，属于
权威 Project namespace，**不得**复用或迁入 `graph/<libraryID>.json`。

## 6. 未实现：文献数据源边界与本地 corpus

Home 应面向能力接口而不是直接假定在线 provider：一个 `LiteratureSource` 声明自己
支持 resolve / search / references / citations / coupling / semanticNeighbors / offline
中的哪些，组合层按「已验证缓存 → 可选 runtime corpus → 在线 provider」的顺序使用。
在线 provider 留在 add-on，本地 corpus 通过 runtime-client 访问 `paper-runtime`；
add-on 不导入 Python 实现，runtime 也不读 Zotero API。

**在下列需求真实出现之前，只做 seam，不下载大型数据**：需要在大量库外论文中搜索与
连续跳转；需要高频 coupling / 共同引用 / 相似邻域查询；provider 限流或结果漂移明显
影响探索；需要离线；需要固定数据版本的可复现结果；需要在线 API 不适合的批量查询。

达到门槛后，corpus 必须：位于 `paper-runtime` 的 runtime home 而非 Zotero data
directory；用 bulk snapshot 与增量更新而非逐篇抓取；记录数据版本、来源和更新时间；
只通过异步、分页、有限 top-N 的 localhost API 返回邻域；不把全局边表加载进 Zotero 的
JavaScript 内存；不把正在使用的 SQLite 文件当作双向同步对象。WebDAV 可以托管只读的
corpus release artifact，但 updater 必须下载、校验、关闭数据库并原子替换——那是与状态
同步完全不同的工作流。

## 7. 待决问题

- 个人库 portable scope 如何与远端 profile bootstrap 绑定；
- 是否需要内容压缩，以及 Zotero 环境可依赖的压缩能力；
- Citations 的默认同步上限；
- cache freshness policy 是否按 provider 分别配置；
- 何种真实查询与延迟指标足以触发本地 corpus 实现；
- 库外论文 identifier 冲突的**用户审阅流程**——数据层已能报告冲突并执行显式 merge，
  缺的是让用户作决定的界面。

若两台设备在第一次同步前分别为同一 Collection 建了不同 Project UUID，导入会明确报告
subject conflict 而不静默覆盖。在 Project identity redirect 落地前，应先在已有 Project
的设备上传，再在第二台设备第一次打开 Home 之前下载。
