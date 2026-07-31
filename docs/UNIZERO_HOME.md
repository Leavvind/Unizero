# Unizero Home — Project View 设计

> **产品状态（本分支）：Legacy。** Unizero Home / Project View / Board 仍在代码树中，
> 但不再是产品重心；默认不要扩展或重构。主动开发在 Obsidian 插件与 Zotero 数据面
> （providers、cache、relations、bridge、conversion）。见根目录 [README](../README.md)
> 与 [AGENTS.md](../AGENTS.md)。
>
> **实现状态（历史）：** 三栏 Project View、Board MVP（重复节点、平移缩放、移动、
> 缩放、tombstone、手工连线、Text Node 与嵌入式 PaperBlock、hover 关系提示）、统一
> Paper catalog（cache/pinned/zotero、citation observation、快照压缩、GC、显式
> merge/redirect）与手动/定时 WebDAV Project/Board sync 已实现。Literature 命名空间
> 同步、冲突审阅 UI 与 Project 身份迁移仍未完成，见 [ROADMAP.md](ROADMAP.md) 中
> Background 段——它们不是当前迭代目标。

## 1. 产品决定

1. `Literature Explorer` 的产品名称改为 `Unizero Home`。
2. 一个 Zotero Collection 对应一个 Project；library root 也可以有自己的 Project。
3. 第一版一个 Project 只有一个默认 Board，schema 允许以后扩展。
4. Home 的主视图是三栏 Project View：
   - 左栏：当前 Collection 的 Zotero 文献；
   - 中栏：可编辑 Board；
   - 右栏：References / Relation / Citations / metadata Detail View。
5. 左右栏均可折叠。
6. 全库自动图与管理表已删除。UniConnection 本身保留并且更重要了——它现在同时供 hover
   高亮、临时关系提示、筛选、单篇 Graph 标签和未来的推荐使用。取舍与遗留约束见
   [UNICONNECTION.md](UNICONNECTION.md)。

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

当前 Node schema 是兼容旧数据的 union：原有 `paper` Node 无需迁移；`text` Node
拥有带稳定 block ID 的有序内容数组。TextBlock 保存文字，PaperBlock 只保存
`paperID` 引用。把论文拖进 Text Node 不复制元数据，也不创建 Zotero item。

库外 Paper 被加入 Zotero 时，只为原 Paper 增加 Zotero binding。不得创建一个新
Paper 并替换 Board 上的身份。

当前最小实现按 DOI、arXiv、Semantic Scholar Paper ID 与 OpenAlex ID 维护 alias。Detail 中的
库外结果拖到 Board 后成为 `pinned` Paper，不触发 Zotero 写入；以后遇到同一可靠
identifier 的 Zotero item 时，在原 Paper 上增加 binding，并将 retention 提升为
`zotero`。标题和作者仍不参与自动合并。

## 3. 文献模型

库内外 Paper 使用相同 `PaperDocument` schema，但不具有相同的权威性和保留策略：

- Zotero-bound：长期保存，Zotero metadata 仍是权威；
- Board-pinned：长期保存，作为 Project 依赖同步；
- 仅在探索结果出现：可清理 cache。

当前 References/Citations snapshot 中每个结果都会进入 Paper catalog，而不再只有
拖到 Board 后才保存。retention 只能按 `cache → pinned → zotero` 提升，后续浏览
不会把 pinned 或 Zotero-bound Paper 降级。无可靠 identifier 的结果使用
`seed Paper + query kind + provider/order` 范围内的 provisional mapping；它保证
同一缓存重复打开时身份稳定，但不把标题变成全局 alias。

References 与 Citations 是发现同一条有向 citation edge 的两条路径。关系统一为：

```text
citingPaper → citedPaper
```

provider、查询方向、抓取时间、分页和 source order 保存在 observation/snapshot，
不能被压平为无来源、无时间的永久事实。

第一阶段已将 References 保存为 `seed → result`，Citations 保存为
`result → seed`；同一 provider/query/edge 重复读取会更新原 observation。Board
hover 同时读取 `UniConnection` 与这些 observation，因此 Citations 发现的库外
source 也可参与 Paper ID 级的临时提示。observation index 按 Paper ID 维护邻接
关系；Relation Hint 只读取当前 Board Paper 集合相邻的 observation，不再先扫描
全库 observation 文件。旧 index 会在升级后首次读取时自动重建一次。

只有成功且已经到达末页的 provider snapshot 才能替换同一查询路线的旧
observation；分页未完成或 provider 失败不会删除既有证据。替换后失去全部
observation 的 cache-only Paper 会被回收，pinned 与 Zotero-bound Paper 不会。

多个 reliable identifiers 指向不同 Paper 时，数据层返回 conflict 而不静默挑选。
显式 merge 由调用方选择 canonical Paper，旧 ID 写入 redirect，相关 observations
随之改写和去重。多个 Zotero binding 合并后，canonical Paper 原有 binding 保持
metadata owner；用户可见的冲突审阅 UI 仍待实现。

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

当前 Board 使用 DOM card + SVG edge 的共同 world coordinate layer。滚轮平移，
Ctrl/Cmd + 滚轮或工具栏缩放，拖动空白区域平移，“适应白板”按当前 Node 重新取景。
camera 属于窗口临时状态，不与不可丢失的 Node geometry 混存。

左栏库内论文可重复拖入；每次 drop 创建独立 Node，移动只更新该 Node geometry，
Delete / Backspace 写入 tombstone。点击 Node 复用右侧现有 Detail View。Node 四边
提供 connection handle；从 handle 拖到另一个 Node 会显示实时曲线预览并创建独立
manual edge 文档。连线端点落在卡片边缘，可被单独选择和删除；删除 Node 也会
tombstone 其关联连线。工具栏“连线”仍保留为键盘可用的替代路径。

References / Citations 的行可以直接拖到 Board。库内结果复用 Zotero-bound Paper；
库外结果创建或复用 Board-pinned Paper。悬停具有可靠 identifier 的 Paper Node
时，`UniConnection` 会把 Board 当前 Paper ID 投影为派生边，临时高亮所有同 Paper
实例与相关 Paper 实例，并绘制虚线 overlay；库内 source 因而也能提示它引用的
库外 Board Paper。离开后提示消失，不产生 manual edge 文档。

Paper 与 Text Node 的右下角提供缩放柄。缩放按当前 camera zoom 换算为 world
geometry，拖动时连线端点实时更新，结束后保存 width/height。

工具栏“文字”创建可直接编辑的 Text Node。文字在短 debounce 或失焦时保存；将左栏
库内论文拖进文字容器会追加 PaperBlock。库内 PaperBlock 可以再次拖到白板空白处，
复制成独立 Paper Node；移除嵌入块不影响 Paper catalog 或其他实例。该 Content
Block 交互目前保留为实验能力；下一轮扩展前应先重新评估更接近 Obsidian Canvas 的
独立卡片、容器与组合方式。

## 5. 本地持久化与同步边界

当前本地投影位于：

```text
<Zotero data dir>/unizero/projects/
```

Project、Board、Node、Edge 和 tombstone 都按独立、带 schema 的对象保存，避免一个
巨大 Board JSON 造成整板冲突。本机目录不是远端协议；同步层传输 typed documents。

已实现的 sync namespace（见 `src/sync/types.ts`）：

```text
project.meta
project.board
project.board-node
project.board-edge
```

已定义但尚未接入 sync engine：

```text
literature.paper
literature.paper-redirect
literature.observation
```

`settings.portable` 仍是设计设想，尚未定义。

Project 对象是非重建状态，优先于 provider cache。远端删除必须通过 tombstone
传播。Graph layout 仍可丢弃；Board geometry 不可丢弃，二者不得复用 namespace。

## 6. 现有能力的复用边界

- 复用 `views.ts` 的 Detail snapshot、三源查询与库内 membership。
- 复用 `UniConnection` 计算 hover hint，不把它变成 Board owner。
- 复用 `src/ui/literatureExplorer.ts` 的 plain-object window bridge。
- `literature-graph.js` 保留为 force-graph renderer（现供单篇 Graph 标签），不改造成白板。
- 新 Board renderer 只消费 Project/Paper/Node/Edge 纯数据。
- Node context menu 改为 capability action registry；Raw Markdown、详细 Notes、
  Canvas Obsidian 等成为命名 action/binding。
