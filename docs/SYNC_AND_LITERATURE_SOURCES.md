# 同步与文献数据源设计

> 中文设计文档。已实现行为的权威描述在 [ARCHITECTURE.md](ARCHITECTURE.md)；未完成
> 工作清单在 [ROADMAP.md](ROADMAP.md)。落地类型以 `src/sync/types.ts` 和
> `src/projects/types.ts` 为准——本文不复制声明。

## 状态

| 部分 | 状态 |
|---|---|
| typed document / namespace registry / backend-neutral engine | 已实现 |
| WebDAV backend、immutable pack、per-device manifest、本机 checkpoint | 已实现 |
| Login Manager 凭据、手动与定时同步 | 已实现 |
| `project.meta` / `project.board` / `project.board-node` / `project.board-edge` | 已实现 |
| 统一 Paper catalog、citation observation、merge/redirect（数据层） | 已实现 |
| `literature.*` namespace 同步 | **未实现**（见 ROADMAP） |
| `settings.portable` | **未实现**（见 ROADMAP） |
| Project 身份迁移与冲突审阅 UI | **未实现**（见 ROADMAP） |
| pack compaction / GC | **未实现**，需先设计（见 ROADMAP） |

## 1. 核心决策

### 1.1 Zotero 继续是权威来源

bibliographic fields、annotations、collection membership 和原生 Related Items 由
Zotero 所有，走 Zotero Sync。UniZero 同步得到的 provider metadata 只能是候选、缓存
或探索数据；除非用户通过既有 Zotero mutation 流程确认，否则不能覆盖 Zotero item。

### 1.2 同步原料，不同步派生连接

References 是连接的可携带原料，每台设备各自建立 `UniConnection`：

```text
Zotero items + References cache → UniConnection build/ingest → relations / coupling / topology
```

自动 topology 不上传。见 [UNICONNECTION.md](UNICONNECTION.md)。

### 1.3 本机目录不是同步协议

本机继续用适合进程内查找的路径（如 `<libraryID>/<itemKey>.json`）。远端保存带类型、
版本和 subject 的同步文档；同步层负责映射。

### 1.4 WebDAV 只是 backend

WebDAV 负责列举、下载、条件写入和删除对象，**不理解**业务语义。schema migration、
冲突合并、dirty tracking 属于同步引擎和各 namespace。

### 1.5 身份与文档 ID 必须分离

- 同步对象的 `id` 标识一个需要版本控制的逻辑文档，创建后**永远不变**；
- 论文身份由 identifiers 与 Zotero binding 描述，可以随时被补全或合并；
- 后来补上 DOI、或发生 identifier merge 时，更新身份，**不动** `id`。

跨设备协议一律使用 portable library scope（`ZoteroLibraryScope`），不写本机数字
`libraryID` 或 `collectionID`。

## 2. 不变量

改动同步相关代码前应逐条对照：

- cache 不创建 Zotero item，也不覆盖 Zotero bibliographic fields；
- 一条远端记录不能跨 library scope 导入；
- identifier mismatch 是 miss，不是「尽量匹配」；
- topology 永远可以从 Zotero + References 重建，所以它永远不进同步；
- 同步失败不阻断本机 References/Citations 的正常使用；
- secret 不进入同步 payload、typed document、checkpoint 或日志；
- 旧客户端遇到未知 schema 必须清楚失败，不能静默降级写坏远端；
- 冲突不能被当成成功——capability probe 必须识别弱条件写入；precondition failure
  绝不能报成写入成功。

一次正常 pull 的顺序：等待本机 library 可用 → 拉取 typed documents → 解析 portable
scope 与 item key → 确认 Zotero item 存在 → 校验 subject identifiers → migrate 与
merge → 原子写入 → 更新内存状态 → 保存 revision。

运行时不变量（已实现，ARCHITECTURE 也有）：

- 报告仍有剩余 work 的 run 是 continuation，不是最终结果；
- 未知 namespace 跳过、不 fatal，checkpoint 记录以便日后 replay；
- 内容寻址与 locale 无关（code-unit 排序 + invariant case folding）。

## 3. 未实现方向（摘要）

细节与优先级只在 [ROADMAP.md](ROADMAP.md) 维护，此处只记约束：

**Literature namespace** — 下一批：`literature.paper`、`literature.observation`、
`literature.paper-redirect`，之后才评估 References/Citations snapshot。subject
identifiers 不匹配时拒绝导入；完整 resolved 结果优先；imported shard 写完后必须
`ingestItem` 或 invalidate/rebuild。Citations 分页状态按 provider 独立保存；**新
total 不能证明旧 entries 已过期**。

**设置同步** — 每个公开设置声明 portability，未声明默认 `device`。portable 按 key
合并，不是整份 LWW。secret 与本机路径永不进入同步。Graph layout 默认同不同步；Board
geometry 属于 Project namespace，不得迁入 `graph/<libraryID>.json`。

**Pack GC** — packs 不可变且从不删除，远端会无限增长。回收需要先设计：设备公布已
应用内容、可识别 supersede、长期离线设备既不能永远挡住回收也不能丢未读数据。

**能力边界 / 本地 corpus** — 在真实查询证明在线 provider + 可移植 cache 不足之前
不做大型 corpus 产品。若将来做，应经 runtime 的版本化 API，不把 bulk 图载入
Zotero 进程内存。

## 4. 待决问题

- 个人库 portable scope 如何与远端 profile bootstrap 绑定；
- Citations 的默认同步上限与 per-provider freshness；
- 库外论文 identifier 冲突的**用户审阅流程**——数据层已能报告冲突并执行显式 merge，
  缺 UI。

若两台设备在第一次同步前分别为同一 Collection 建了不同 Project UUID，导入会明确
报告 subject conflict 而不静默覆盖。在 Project identity redirect 落地前，应先在
已有 Project 的设备上传，再在第二台设备第一次打开 Home 之前下载。
