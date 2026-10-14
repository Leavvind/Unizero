# Zotero 笔记层：取代 Better Notes

| 状态 | 内容 |
| --- | --- |
| 已实现，待 Zotero 手动验证 | 转换层（第 1 部分）、长笔记拆分、链接层（第 2 部分） |
| 设计中，未实现 | 反向转换（第 3 部分） |
| 推迟 | 编辑器增强（第 4 部分） |

本文是设计文档，记录决定、约束和陷阱。已实现部分的当前行为以代码和
[add-on README](../apps/zotero-addon/README.md) 为准；未完成的工作见
[ROADMAP](ROADMAP.md#raw-note)。

## 目标

UniZero 原本借用 Better Notes（下称 BN）做两件事：把 Markdown 转成 Zotero 笔记 HTML，
以及处理 `zotero://note/...` 链接。BN 的其余功能对本项目没有用处，而本项目需要的一些
功能 BN 也不提供。目标是由 UniZero 自己实现这两件事，再加上"笔记转 Markdown"，之后
卸载 BN。**不考虑与 BN 共存。**

不在范围内：

- **图片。** Raw 笔记不放图片。BN 的 `md2html` 本来也不导入图片，只有它自己的
  "导入 Markdown"命令（`md2note`）才会导入。
- **BN 的工作区、模板、关系图、同步、docx/LaTeX/PDF 导出。**

## 来源与许可

参照对象是 BN 3.3.3（commit `4215a88`，2026-08-24）。BN 和 UniZero 都是 AGPL-3.0。
来源记录在 [NOTICE](../NOTICE) 和移植文件的头部注释里；对照上游修复时从那里找对应文件。

## 1. 转换层：Markdown → 笔记 HTML

代码在 `apps/zotero-addon/src/notes/markdownToNote.ts`，是纯模块，不调用 Zotero API。

### 决定

- **放在 add-on，而不是 runtime。** 放在 Python 一侧等于把 BN 的 `rehype2note` 规则
  重写一遍；直接移植 TS 代码更省事，也方便和上游对照。
- **只移植 `md2html` 这一条路径**：`md2remark` → `remark2rehype` → `rehype2note`。
  `rehype2note` 里是 Zotero note-editor 的格式规则（公式写成 `span.math` / `pre.math`、
  表格去掉 `thead`、列表文本包 `<span>` 等），保持和上游一致，不要自行改写。
- **不移植 `parseKatexHTML`。** MinerU 输出的是 TeX，不是 KaTeX HTML。
- **图片节点直接丢弃，保留 alt 文字**，并清理图片前后留下的换行。
- **输出用命名实体**（`&amp;` 而不是 `&#x26;`），与 BN 经过 DOMParser 后的输出一致。
- **在主线程运行。** BN 用 Worker。实测最长的一本书（10 册合集）约 2.5 秒，普通论文
  感觉不到。如果卡顿不可接受再改为 Worker，打包方式参照 BN。

### 验证结果

用本机 Zotero storage 里的 85 份 MinerU Markdown 与 BN 的 `md2html` 逐份对比，
81 份一致。其余 4 份是等价写法（`&#160;`）、MinerU 写出的未闭合标签（BN 经 DOMParser
自动闭合，Zotero 加载时同样会闭合），以及对比脚本自身的近似。单元测试的期望值也逐一
用 BN 跑过。

### 陷阱

- **bundle 在没有 `document` 的环境里执行。** `decode-named-character-reference`
  （unified 的依赖）面向浏览器的版本在加载时调用 `document.createElement`，曾导致整个
  add-on 启动失败，菜单和面板全部消失。`scripts/build.mjs` 用 `alias` 改用它不依赖 DOM
  的版本。以后新增依赖时要注意同类问题：单元测试跑在 Node 里，发现不了。
- TypeScript 4.9 配合当前的 `moduleResolution` 能通过 unified v11 的类型检查，暂时
  不需要升级 TS。

## 长笔记拆分

Zotero 同步笔记的上限按笔记 HTML 的**字符数**计（含标签，与字节无关），实测在
470,000 到 500,000 之间失败。超过 450,000 字符的 Raw 笔记按顶层章节分段拆成多条，
每条约 350,000 字符，开头一行是 `Part i/n`。这一行既是笔记在 Zotero 里的标题，也是
Replace 时识别旧分段的依据：没有这一行的笔记可能是用户自己的，不会被删除。切分点只在
标题前或空行处，不会切进代码块或 `$$` 公式块（`src/notes/splitMarkdown.ts`）。

## 2. 链接层：`zotero://note`

代码在 `apps/zotero-addon/src/zotero/noteLinks.ts`，由 `notes.links` 功能模块在启动时
注册、关闭时移除。

### 决定

- **URL 格式沿用 BN 的**：用户库是 `zotero://note/u/<key>/`，群组库是
  `zotero://note/<groupID>/<key>/`。这样 BN 以前写进笔记里的链接仍然可以用。
- **群组库统一用 `groupID`。** BN 生成链接时写的是 `libraryID`，解析时却按 `groupID`
  处理，两边不一致；UniZero 两边都用 `groupID`。
- **注册方式与 BN 相同**：写入 zotero 协议处理器的私有 `_extensions` 表。Zotero 没有
  公开接口可以新增 `zotero://` 路径。这是 AGENTS.md 所说要尽量避免的私有 API 依赖，
  所以在代码注释里写明了；移除时会恢复被替换掉的旧值。
- **打开方式**：`ZoteroPane.openNote(id, { openInWindow: false })`，在 Zotero 8 的
  笔记标签页中打开。
- **`?line=` 和 `?section=` 只解析，不执行滚动。** 滚动需要操作编辑器内部（第 4 部分）。

### Obsidian 一侧

`openRaw` 只发一个链接：有 `links.rawNoteOpen` 就只打开笔记标签页，否则只选中笔记。
**不要两个都发**：系统把两个 URL 交给 Zotero 时不会等前一个处理完，晚完成的
`zotero://select` 会切回 "My Library" 标签页，把刚打开的笔记盖掉。

## 3. 反向转换：笔记 HTML → Markdown（未实现）

使用场景：把 Zotero 笔记里的内容复制到 Obsidian。

### BN 怎么做

流水线是 `note2rehype` → `rehype2remark` → `remark2md`，同样在 `src/extras/convert.ts`。
它为 Zotero 笔记的结构写了专门的处理函数：带颜色的 `span` 原样输出为 HTML；
`span.math` / `pre.math` 还原成 `$…$` / `$$…$$`；`u`、`sub`、`sup` 输出为 HTML 标签；
没有表头的表格第一行用 `<!-- -->` 占位；处理 `li` 中行内公式两侧的空格（BN #1300、#820）。
外层还有需要 Zotero 的步骤（`src/utils/convert.ts` 的 `processN2MRehype*Nodes`）：
引用、高亮、笔记链接和图片。

### UniZero 的设计

- 把纯函数部分移植到 `src/notes/`，与第 1 部分共用依赖。
- 加上 BN 给不了的映射：
  - Zotero 引用（`span.citation[data-citation]`）转成 Obsidian 插件的
    `@libraryID/itemKey` 语法，粘进 Obsidian 就是可点击的引用；
  - 高亮（`span.highlight[data-annotation]`）转成引用块，后附 `zotero://open-pdf` 回链；
  - `zotero://note` 链接保持原样，由第 2 部分负责打开。

### 待决定：入口

可以多选：

- Zotero 笔记右键菜单"复制为 Markdown"，复制整条笔记（最简单）；
- 新增只读的桥接接口，例如 `GET /unizero/v1/notes/<lib>/<key>/markdown`，让 Obsidian
  插件插入或嵌入笔记内容（需要改桥接协议）；
- 复制选中的一段（需要第 4 部分的编辑器注入）。

## 4. 编辑器增强（推迟）

BN 的这类功能都是向 Zotero 的 note-editor iframe（ProseMirror）注入代码实现的，依赖
私有内部实现，Zotero 一升级就可能失效。等确定了具体需求再逐项评估。候选项：

- 按 `?line=` 或 `?section=` 滚动到指定位置；
- 大纲或目录侧栏；
- 在编辑器里选中一段内容，复制为 Markdown（依赖第 3 部分）。
