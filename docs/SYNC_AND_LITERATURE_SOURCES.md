# 同步状态与文献数据源设计

> 状态：设计提案，尚未实现。本文记录边界、约束和推荐接口，不定义
> Workspace 的最终产品形态，也不构成实施工单。未完成工作以
> [ROADMAP.md](ROADMAP.md) 为准。

## 1. 问题

UniZero 当前把每篇 Zotero 文献的 provider 结果保存在本机：

```text
<Zotero data directory>/unizero/cache/<libraryID>/<itemKey>.json
```

分片内目前有两个正式记录：

- `References-Resolved-v4`；
- `Citations-v4`。

References 是 `UniConnection` 的输入。库内反向引用、bibliographic coupling
和 Graph topology 都可以由 References 与 Zotero item 身份重新计算；Citations
只服务 Citation 视图，不参与现有 topology。因而第二台电脑虽然可以重新下载
provider 数据并重建连接，却不能继承第一台电脑已经付出的下载、解析和限流成本。

除此之外，UniZero 已经有多种不同性质的本机状态：

| 状态 | 当前保存位置 | 性质 |
| --- | --- | --- |
| References/Citations provider 结果 | `unizero/cache/` | 昂贵但可重建的缓存 |
| Graph layout | `unizero/graph/<libraryID>.json` | 可丢弃的显示状态 |
| Graph display/force 设置 | `unizero/graph/settings.json` | 用户偏好 |
| 插件偏好 | Zotero preference branch | 用户偏好、设备配置或密钥 |
| 关系索引和 topology | 内存 | 纯派生状态 |

未来还可能出现用户主动创建且不可丢弃的状态，例如某种写作项目、思路板、卡片、
手工关系或备注。它们的具体形态尚未确定，但同步边界不能假定所有未来状态都是
cache，也不能把当前磁盘目录直接固化成远端协议。

## 2. 目标

本设计希望先建立两个互相独立的扩展点：

1. **文献数据源边界**：Literature Explorer 不依赖数据来自在线 provider
   还是未来的本地 corpus。
2. **可同步状态边界**：功能模块不依赖远端是 WebDAV、同步目录还是未来的服务。

近期目标是：

- 允许 References/Citations 在两台设备间复用；
- 允许明确列入白名单的便携设置同步；
- 保持现有本机 shard 格式可用，不要求一次性迁移；
- 为未知的未来状态预留带 schema、scope 和冲突策略的 namespace；
- 让 WebDAV 成为第一个 backend，而不是让 WebDAV 规则渗入 cache、Graph
  或 Explorer。

## 3. 非目标

本设计不要求：

- 现在定义 Workspace 的 UI、功能或持久化模型；
- 现在部署 Finance/Economics 本地大型数据库；
- 把整个 Zotero data directory 放入云盘；
- 同步 `UniConnection` 内存索引或 Graph topology；
- 让同步缓存成为 Zotero 元数据的第二权威来源；
- 读取或复用 Zotero 内部保存的 WebDAV 凭证；
- 在第一版传播远端删除；
- 在第一版实现实时协作。

## 4. 核心决策

### 4.1 Zotero 继续是权威来源

Zotero item 的 bibliographic fields、annotations、collection membership 和原生
Related Items 仍由 Zotero 所有并通过 Zotero Sync 同步。UniZero 同步得到的
provider metadata 只能作为候选、缓存或探索数据；除非用户通过既有 Zotero
mutation 流程确认，否则不能覆盖 Zotero item。

### 4.2 同步原料，不同步派生连接

References 是连接的可携带原料。每台设备在导入 References 后，各自建立
`UniConnection`：

```text
Zotero items + References cache
                |
                v
       UniConnection build/ingest
                |
                v
  relations / coupling / graph topology
```

自动 topology 不上传。这样不会形成第二份权威图，也不会引入 topology 与 shard
版本不一致的问题。

### 4.3 本机目录不是同步协议

本机仍可继续用 `<libraryID>/<itemKey>.json`，因为它适合 Zotero 进程内查找和
sweep。远端保存的是带类型、版本和 subject 的同步文档。同步层负责在远端文档
与本机 shard 之间映射。

因此，未来可以改变本机 shard envelope，或让库外论文拥有缓存，而不必改变
WebDAV 的基本传输接口。

### 4.4 WebDAV 只是 backend

WebDAV 负责列举、下载、条件写入和删除对象，不负责理解 References、设置或未来
项目的业务语义。schema migration、冲突合并与 dirty tracking 属于同步引擎和各
namespace。

### 4.5 本地 corpus 只是另一种文献数据源

本地 corpus 不属于同步状态，也不是现有 shard 的放大版。它是可重新部署、
可查询、带数据版本的只读或受控更新数据产品，通过 `paper-runtime` 的版本化
localhost API 暴露。是否安装本地 corpus 不应改变 Explorer 的上层数据形状。

## 5. 设备无关的论文定位

当前 Explorer 的许多路径以 `libraryID + itemKey` 标识论文。这个身份适合本机
Zotero item，但不能独立表示库外论文，也不应把数字 `libraryID` 直接写入跨设备
协议。

建议引入公开的论文定位形状：

```ts
interface PaperIdentifiers {
  doi?: string;
  arxiv?: string;
  semanticScholarPaperId?: string;
  openAlexId?: string;
}

type PaperLocator =
  | {
      kind: "zotero";
      library: PortableLibraryScope;
      itemKey: string;
      identifiers: PaperIdentifiers;
    }
  | {
      kind: "external";
      identifiers: PaperIdentifiers;
    };
```

`PortableLibraryScope` 使用可跨设备解释的逻辑 scope，例如个人库或
`groups/<groupID>`，不使用本机数字 `libraryID`。本机 adapter 在读取和写入 shard
时再解析为当前设备的 `libraryID`。

同步对象的 `id` 与论文 identifiers 必须分离：

- `id` 标识一个需要版本控制的逻辑文档，创建后保持稳定；
- `subject` 中的 `PaperLocator` 描述论文；
- 后来补充 DOI 或发生 identifier merge 时，更新 `subject`，不改变同步对象
  identity。

第一版 Zotero-backed cache 可以从 portable library scope、item key 和 record
kind 确定性地产生文档 ID。未来库外论文可以使用 UUID，并通过 identifiers 做
去重或 alias 解析；本设计暂不规定完整的 external-paper merge 算法。

## 6. 文献数据源接口

Explorer 应面向能力接口，而不是直接假定在线 provider：

```ts
interface LiteratureCapabilities {
  resolve: boolean;
  search: boolean;
  references: boolean;
  citations: boolean;
  coupling: boolean;
  semanticNeighbors: boolean;
  offline: boolean;
}

interface LiteratureSource {
  capabilities(): Promise<LiteratureCapabilities>;

  resolve(locator: PaperLocator): Promise<PaperRecord | undefined>;

  search(
    query: LiteratureQuery,
    cursor?: string,
  ): Promise<PaperPage>;

  references(
    locator: PaperLocator,
    cursor?: string,
  ): Promise<RelationPage>;

  citations(
    locator: PaperLocator,
    cursor?: string,
  ): Promise<RelationPage>;

  neighbors(
    locator: PaperLocator,
    query: NeighborQuery,
  ): Promise<RelationPage>;
}
```

不是每个 source 都必须实现所有能力。组合层根据 capability 和策略依次使用：

1. 已验证的本机/同步缓存；
2. 可选的 runtime corpus；
3. 在线 provider。

在线 provider 仍可留在 add-on；本地 corpus 通过 runtime-client adapter 访问
`paper-runtime`。add-on 不导入 Python 实现，runtime 也不读取 Zotero API。新增
runtime literature endpoint 时，仍需遵守 v1 contract 的同步修改规则。

## 7. 本地大型数据库的决策门槛

本地数据库的价值不是把单篇在线请求改成本机请求。单篇 DOI 解析、少量
References/Citations 浏览继续使用在线接口通常更轻。

只有出现下列一种或多种需求时，本地 corpus 才有明确收益：

- 需要在大量库外论文中搜索、筛选和连续跳转；
- 需要高频执行 bibliographic coupling、共同引用或相似邻域查询；
- provider 限流、网络波动或结果漂移明显影响探索；
- 需要离线使用；
- 需要用固定数据版本获得可复现结果；
- 需要跨期刊、年份、主题或作者做在线 API 不适合的批量查询。

在达到门槛前，只实现 `LiteratureSource` seam，不下载大型数据。

达到门槛后，corpus 应满足：

- 位于 `paper-runtime` 的 runtime home，而非 Zotero data directory；
- 使用 bulk snapshot 和增量更新，而非逐篇 API 抓取；
- 记录数据版本、来源和更新时间；
- 只通过异步、分页、有限 top-N 的 localhost API 返回 Explorer 所需邻域；
- 不把全局边表加载进 Zotero 的 JavaScript 内存；
- 不把正在使用的 SQLite 文件作为多设备双向同步对象。

WebDAV 可以托管只读的 corpus release artifact，但 runtime updater 必须下载、
校验、关闭数据库并原子替换；这与一般状态同步是两个不同工作流。

## 8. 同步模型

### 8.1 Backend

```ts
interface RemoteObject {
  body: Uint8Array;
  revision?: string;
  modifiedAt?: number;
}

interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

interface SyncBackend {
  connect(): Promise<void>;
  list(prefix: string, cursor?: string): Promise<RemotePage>;
  get(key: string): Promise<RemoteObject | undefined>;
  put(
    key: string,
    body: Uint8Array,
    condition?: WriteCondition,
  ): Promise<RemoteRevision>;
  remove(key: string, condition?: WriteCondition): Promise<void>;
}
```

backend 不接受 Zotero item，也不返回 `ReferencesCache`。它只处理 bytes、key 和
revision。

### 8.2 Typed document

```ts
type SyncScope =
  | { kind: "profile"; id: string }
  | { kind: "library"; id: string }
  | { kind: "project"; id: string };

interface SyncDocument<T> {
  namespace: string;
  id: string;
  schema: number;
  scope: SyncScope;
  subject?: PaperLocator;
  updatedAt: number;
  deviceID: string;
  payload: T;
}
```

远端 key 是同步引擎的存储细节，例如：

```text
unizero/v1/objects/<namespace>/<scope>/<id>.json
```

业务代码不能依赖这条路径。

### 8.3 Namespace

```ts
interface MergeContext {
  localRevision?: string;
  remoteRevision?: string;
}

interface SyncNamespace<T> {
  name: string;
  currentSchema: number;
  encode(value: T): SyncDocument<T>;
  decode(document: SyncDocument<unknown>): T;
  migrate(document: SyncDocument<unknown>): SyncDocument<T>;
  merge(local: T, remote: T, context: MergeContext): T;
}
```

第一批 namespace 可以是：

```text
literature.references
literature.citations
settings.portable
graph.settings
```

未来状态只有在产品形态明确后才增加 namespace；`project` scope 的存在不等于
现在已经决定 Workspace 的模型。

### 8.4 Sync engine

同步引擎负责：

- 本机 dirty queue；
- `deviceID`；
- pull/push cursor 或远端 revision；
- schema migration；
- ETag/conditional write；
- 冲突重读、调用 namespace merge 后重试；
- retry、backoff 和取消；
- 状态、最近成功时间与可诊断错误；
- 防止同一对象在一个设备内并发上传；
- 对日志中的 URL userinfo、authorization 和 secret 做脱敏。

第一版可以用 `PROPFIND` 列出 namespace，再以 ETag 增量读取。若实际库规模证明
完整列举过慢，再引入每设备 change journal；backend 接口不因此改变。

## 9. WebDAV backend

第一版 WebDAV 需要：

- `PROPFIND`；
- `GET`；
- `PUT`；
- `MKCOL`；
- 可选的 `DELETE`；
- ETag；
- `If-Match` 与 `If-None-Match`；
- Basic authentication 或用户提供的 bearer-compatible 凭证方式；
- HTTPS；
- capability probe；
- timeout、取消与有限重试。

不依赖 `LOCK`。正常写入流程是：

1. GET 并记录 ETag；
2. 合并本机与远端 typed document；
3. PUT 时发送 `If-Match`；
4. 收到 precondition failure 后重新 GET、merge、retry；
5. 有限重试失败后保留本机 dirty 状态并向用户报告。

有些 WebDAV 服务可能不给出可用于强条件写入的 ETag。capability probe 必须识别
这种情况；backend 可以退化为文档 revision 检查，但不能把冲突当成成功。

WebDAV URL、username 和远端 root 属于设备 bootstrap 配置。password/token 是
secret，不能写入普通 preference export、typed document 或日志。具体安全凭证
存储机制需要在实现前验证 Zotero 8 可用的公开能力；未验证前不能以明文 preference
作为默认方案。

## 10. Cache 同步

### 10.1 References

References 是第一优先级，因为：

- 它驱动现有 Relation、coupling 和 Graph；
- reference list 相对稳定；
- 重新获取可能触发大量 enrichment 请求；
- 第二台设备导入后可以立即重建 topology。

合并规则：

- subject identifiers 不匹配时拒绝导入；
- schema 未知且不能 migrate 时保留远端对象并报告不兼容；
- 完整 resolved 结果优先于不完整结果；
- 同一 provider 的较新成功结果优先；
- 不同 provider 的结果保留 provenance 后按既有 identity 规则 union；
- 匿名 edge 可以保留用于显示，但不能因此获得虚构 identity；
- imported shard 写完后调用该 library 的 `ingestItem` 或 invalidate/rebuild。

### 10.2 Citations

Citations 是第二优先级，因为它持续增长、可能分页很多，而且不参与当前 topology。

合并规则：

- 每个 provider 独立保存分页状态、total 和 fetched time；
- entries 按稳定论文 identity 去重；
- 新 total 不能简单证明旧 entries 已过期；
- 不同 source 的 page cursor 不能互换；
- 展示“截至何时”的 provenance，不把 citation count 当成永恒事实。

### 10.3 Pull/push 时机

第一版提供：

- 用户显式 `Sync now`；
- add-on 启动后的延迟 pull；
- 打开 Explorer 或读取 miss 时的非阻塞 pull；
- References/Citations 成功写 shard 后的 debounce push；
- 网络失败时继续使用本机状态。

不应依赖未验证的 Zotero 私有 sync hook。若后续确认有稳定的公开生命周期事件，
可以增加“Zotero Sync 完成后 pull”，但它不是第一版正确性的前提。

第一版不传播 cache 删除。远端对象只有在对应 Zotero item 存在且 subject 验证通过
时才导入，因此陈旧 cache 不会复活 item。远端垃圾回收可以以后按 last-seen 和
明确保留策略增加。

## 11. 设置同步

插件设置不能作为一个整体上传。每个公开设置都必须声明 portability：

```ts
type SettingPortability = "portable" | "device" | "secret";

interface SettingDefinition<T> {
  key: string;
  defaultValue: T;
  portability: SettingPortability;
}
```

分类原则：

| 类别 | 示例 | 行为 |
| --- | --- | --- |
| `portable` | Graph 外观与 force 偏好、通用 UI 行为 | 可进入 `settings.portable` |
| `device` | Python path、server script、port、本机文件路径、进程启动策略 | 只留本机 |
| `secret` | Semantic Scholar API key、WebDAV password/token | 不进入普通同步 |

具体 preference 必须逐项进入白名单；没有声明的设置默认 `device`。portable settings
按 key 合并，而不是整份 latest-write-wins，以免两台设备修改不同设置时互相覆盖。

Graph layout 默认不同步，因为当前 layout 是可重建的显示状态，而且坐标有效性依赖
layout version、force signature 和 library scope。未来若某种画布坐标表达用户主动
组织的意义，它应成为新的权威 namespace，而不是复用 `graph/<libraryID>.json`。

## 12. 同步顺序与一致性

一次正常 pull 的顺序是：

1. 等待本机 Zotero library 可用；
2. 拉取 typed documents；
3. 解析 portable library scope 与 item key；
4. 确认 Zotero item 存在；
5. 校验 DOI/S2/OpenAlex 等 subject identifiers；
6. migrate 与 merge；
7. 原子写入本机 shard 或设置；
8. 更新相应内存状态；
9. 保存 remote revision/cursor。

关键不变量：

- cache 不创建 Zotero item；
- cache 不覆盖 Zotero bibliographic fields；
- 一条远端记录不能跨 library scope 导入；
- identifier mismatch 是 miss，不是“尽量匹配”；
- topology 永远可以从 Zotero + References 重建；
- 同步失败不阻断本机 References/Citations 使用；
- secret 不进入同步 payload 或日志；
- 旧客户端遇到未知 schema 必须清楚失败，不能静默降级写坏远端。

## 13. 推荐实施顺序

路线图只记录可执行的未完成工作；从依赖顺序看，建议：

1. 定义 `PaperIdentifiers`、`PaperLocator`、typed document 和 namespace contract；
2. 为当前 cache 增加导出/导入 adapter，不改变 shard 读路径；
3. 实现 backend-neutral sync engine 与 host-independent tests；
4. 实现 WebDAV capability probe、GET/list/conditional PUT；
5. 先接入 References，再接入 Citations；
6. 建立设置 portability catalog，只同步明确白名单；
7. 让 Explorer 的 provider 编排逐步面向 `LiteratureSource`；
8. 用真实使用数据评估是否实现 runtime corpus；
9. 等未来用户创作状态的产品模型明确后，再增加新的 project namespace。

## 14. 验证标准

自动测试至少覆盖：

- portable library scope 映射；
- typed document schema migration；
- References/Citations merge；
- settings key-level merge；
- ETag conflict 重读与有限 retry；
- unknown schema、identifier mismatch 和跨库记录拒绝；
- dirty queue 在失败后保留；
- 日志脱敏；
- 两台模拟设备修改不同对象时都能收敛。

手工 Zotero 验证至少覆盖：

- 个人库与群组库；
- 两台设备本机 `libraryID` 不同但 portable scope 相同；
- A 获取 References，B 不调用 provider 即恢复并重建 Relation/Graph；
- 离线启动继续使用本机 cache；
- WebDAV 认证失败、证书失败和配额不足的可见错误；
- 设备设置与 secret 没有被远端覆盖；
- Zotero item DOI 修改后旧 cache 被拒绝。

## 15. 待决问题

实现前仍需作出或验证以下决定：

- 个人库 portable scope 如何与远端 profile bootstrap 绑定；
- Zotero 8 中安全保存 WebDAV secret 的公开机制；
- 第一版支持的 WebDAV 服务器兼容矩阵；
- remote object ID 的编码与最大路径长度；
- 是否需要内容压缩，以及 Zotero 环境可依赖的压缩能力；
- Citations 的默认同步上限；
- cache freshness policy 是否按 provider 分别配置；
- 何种真实查询和延迟指标足以触发本地 corpus 实现；
- 未来库外论文的 alias/merge 规则。

这些问题不妨碍先稳定接口，但不应由目录名或某个 WebDAV 服务的偶然行为替我们作出
决定。
