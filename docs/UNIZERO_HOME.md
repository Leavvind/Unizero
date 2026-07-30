# Unizero Home — Project View 设计

> 状态：Project/Board/Paper schema、每 Collection 的稳定 Project 初始化和产品改名已实现；
> 三栏 Board、统一 Paper catalog 与同步仍在施工。未完成工作以
> [ROADMAP.md](ROADMAP.md) 为准。

## 1. 产品决定

1. `Literature Explorer` 的产品名称改为 `Unizero Home`。
2. 一个 Zotero Collection 对应一个 Project；library root 也可以有自己的 Project。
3. 第一版一个 Project 只有一个默认 Board，schema 允许以后扩展。
4. Home 的主视图是三栏 Project View：
   - 左栏：当前 Collection 的 Zotero 文献；
   - 中栏：可编辑 Board；
   - 右栏：References / Relation / Citations / metadata Detail View。
5. 左右栏均可折叠。
6. 现有自动图不再作为主视图。UniConnection 保留，用于 hover 高亮、临时关系提示、
   筛选和未来推荐。

## 2. 身份

Project subject 使用：

```text
portable library scope + Zotero collection key
```

不得使用本机数字 `libraryID` 或 `collectionID` 作为跨设备身份。Project 自身拥有
稳定 UUID；Collection 改名只更新显示名称，不替换 Project。

Paper 与 BoardNode 是两个概念。同一 Paper 可以被多个 Node 引用，每个 Node 拥有
独立坐标、大小、视觉属性和备注。手工 Edge 连接 Node instance；若用户要写入
Zotero Related Items，必须使用独立的显式命令。

库外 Paper 被加入 Zotero 时，只为原 Paper 增加 Zotero binding。不得创建一个新
Paper 并替换 Board 上的身份。

## 3. 文献模型

库内外 Paper 使用相同 `PaperDocument` schema，但不具有相同的权威性和保留策略：

- Zotero-bound：长期保存，Zotero metadata 仍是权威；
- Board-pinned：长期保存，作为 Project 依赖同步；
- 仅在探索结果出现：可清理 cache。

References 与 Citations 是发现同一条有向 citation edge 的两条路径。关系统一为：

```text
citingPaper → citedPaper
```

provider、查询方向、抓取时间、分页和 source order 保存在 observation/snapshot，
不能被压平为无来源、无时间的永久事实。

DOI、arXiv、Semantic Scholar 和 OpenAlex identifiers 可以成为 alias。标题和作者
只能触发疑似重复审阅，不能自动合并。没有可靠 identifier 的记录使用 provisional
内部 ID，后来补 identifier 时保持内部 Paper ID 不变。

## 4. Board 与自动关系

Board 节点、手工边和删除 tombstone 是用户创作状态，不可丢弃。自动引用、
bibliographic coupling 和 topology 仍是派生状态：

```text
Zotero + References → UniConnection → transient Board hints
```

同一 Paper 有多个 Node 时，hover 应高亮所有实例。为避免边爆炸，自动边默认只做
临时 overlay，绝不写入 manual edge 文档。

## 5. 本地持久化与同步边界

当前本地投影位于：

```text
<Zotero data dir>/unizero/projects/
```

Project 和 Board 是独立、带 schema 的对象。未来 Node、Edge 和 tombstone 也按对象
保存，避免一个巨大 Board JSON 造成整板冲突。本机目录不是远端协议；同步层传输
typed documents。

推荐 namespace：

```text
project.meta
project.board
project.board-node
project.board-edge
literature.paper
literature.references
literature.citations
settings.portable
```

Project 对象是非重建状态，优先于 provider cache。远端删除必须通过 tombstone
传播。Graph layout 仍可丢弃；Board geometry 不可丢弃，二者不得复用 namespace。

## 6. 现有能力的复用边界

- 复用 `views.ts` 的 Detail snapshot、三源查询与库内 membership。
- 复用 `UniConnection` 计算 hover hint，不把它变成 Board owner。
- 复用 `src/ui/literatureExplorer.ts` 的 plain-object window bridge。
- `literature-graph.js` 保留为旧自动图 renderer，不改造成白板。
- 新 Board renderer 只消费 Project/Paper/Node/Edge 纯数据。
- Node context menu 改为 capability action registry；Raw Markdown、详细 Notes、
  Canvas Obsidian 等成为命名 action/binding。
