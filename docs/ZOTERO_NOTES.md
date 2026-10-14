# Zotero 笔记层：取代 Better Notes

| 状态 | 内容 |
| --- | --- |
| 已实现，大部分已在 Zotero 验证（Replace、长文档待查） | 转换层（第 1 部分）、长笔记拆分、链接层（第 2 部分） |
| 暂缓 | 反向转换（第 3 部分）。普通复制粘贴已能带过大多数格式；引用转 `@libraryID/itemKey` 要等能在普通笔记里插入引用之后 |
| 已实现，已在 Zotero 验证 | 编辑器增强（第 4 部分）：样式、`?line=` / `?section=` 跳转、右键复制链接、大纲侧栏、高亮和橡皮工具。位置链接还有优化空间；Markdown 粘贴、表格列宽等其余项未做 |

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
- **打开方式**：`ZoteroPane.openNote(id, { openInWindow: false })`，在笔记标签页中打开。
- **`?line=`、`?section=` 和 `?n=` 会滚动到位置。** 含义见 `src/notes/noteLocation.ts`：
  - `line` 是笔记编辑器顶层块的序号（从 0 起），和 BN 一致；超出范围取最后一块。
  - `section` 是标题文字，和 BN 一致。Raw 笔记里标题文字会重复（分段、多册合集），所以 UniZero
    加了 `n`：第几个同名标题，从 1 起，省略就是第一个。`section` 和 `line` 同时出现时先找
    `section`，找不到再用 `line`。
  - 打开链接时只滚动带标签页的那个编辑器实例；同一条笔记在项目面板里的预览实例不动。
  - 笔记编辑器右键菜单里有“Copy link to this block / this section”，复制纯文本链接和一个 `<a>`，
    粘进 Obsidian 会变成 Markdown 链接。

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

## 4. 编辑器增强

“BN 怎么接入编辑器”和“BN 的编辑增强清单”是对 BN 3.3.3（commit `4215a88`）编辑器相关源码的
阅读结果，没有运行过 BN。UniZero 自己做的部分在后面各节，已在 Zotero 里验证。

### BN 怎么接入编辑器

- 补丁 `Zotero.Notes.registerEditorInstance`，每个编辑器实例创建后初始化一次；
  `Zotero.Notes._editorInstances` 用来找到已有实例。两者都是私有 API。
- 往 note-editor 的 iframe 里注入一段脚本和一段样式；脚本通过
  `_iframeWindow.wrappedJSObject._currentEditorInstance._editorCore` 拿到 ProseMirror 的
  view 和 state，用 `state.reconfigure` 追加插件。编辑器内核重建时会重复初始化，所以插件要带
  幂等标记。
- 右键菜单走 `editor._popup`（XUL 菜单），在 `popupshowing` 时追加菜单项，不需要进 iframe。
- 笔记标签页的大纲侧栏靠补丁 `note-editor` 自定义元素的原型、重建标签页布局实现，是最重的一块；
  它甚至在加载时关闭再重开已有的笔记标签页。

### BN 的编辑增强清单

| 功能 | BN 的实现 | 对 UniZero |
| --- | --- | --- |
| `?line=` 跳转 | `line` 是顶层块的序号，取 `docView.children[n]` 的 `offsetTop` 滚动 | **已做**；`line` 一编辑就漂，所以 `section` 优先 |
| `?section=` 跳转 | 按标题文字取第一个同名标题，重名时无法区分 | **已做**；重名标题用 UniZero 加的 `n` 区分 |
| 复制当前位置的链接 | 右键菜单与工具栏菜单的“复制链接”“复制到章节的链接”，取光标所在块和所在章节 | **已做**，是 Obsidian 带回链复制的前提 |
| 大纲侧栏 | 见上，补丁自定义元素 | **已做**，但不补丁元素：面板注入 iframe，见下 |
| Markdown 粘贴 | iframe 内的 ProseMirror 粘贴插件，用 `md2html` 转换 | 转换器已经有，插件约 160 行 |
| 表格列宽拖动、冻结首行首列 | 自带 `columnResizing` 插件 | OCR 出来的宽表格会用到 |
| `/` 魔法键命令 | 扩展 Zotero 自带的 `/` 菜单；有注册表，插件可以注册自己的命令 | 可作为“注入 PDF 高亮”等命令的入口 |
| 任务列表、链接预览、图片预览与缩放 | 各自的 ProseMirror 插件或 DOM 监听 | Raw 笔记没有图片，其余暂不需要 |
| Markdown 编辑模式 | 用 CodeMirror 源码视图盖住编辑器；进入时把笔记转成 Markdown，停手 1 秒后转回 HTML 并整条覆盖笔记；约 2700 行 | 待定：需要保真的反向转换（第 3 部分），且每次保存整条重写 |
| 阅读器里“从标注创建笔记” | 公开接口 `Zotero.Reader.registerEventListener` 给标注头部加按钮；关系存在 BN 自己的 IndexedDB，标注标签同步到笔记 | 模型是“一条标注一条笔记”，和“把高亮注入全文笔记”不是一回事 |

### Zotero 自带的 note-editor 已经有什么

读的是上游 `zotero/note-editor` 的 `src/core`（2026-10-06 的版本）。

- **Markdown 输入规则**（`input-rules.js`）：`# ` 到 `###### ` 标题、`> ` 引用、`- ` / `* ` / `+ `
  列表、`1. ` 有序列表、` ``` ` 代码块、`**粗**` / `__粗__`、`*斜*` / `_斜_`、`~~删除~~`、
  `` `代码` ``、`[文字](链接)`、`$行内公式$`、`$$ ` 块公式、`---` 分隔线。
- **快捷键**（`keymap.js`）：Ctrl+B/I/U、Ctrl+\`（行内代码）、Ctrl+K（链接）、
  Shift+Ctrl+1 到 6（标题）、Shift+Ctrl+0（正文）、Shift+Ctrl+8/9（列表）、Ctrl+>（引用）、
  Shift+Ctrl+\\（代码块）、Tab / Shift+Tab（缩进）。
- **没有的**，Obsidian 有：`==高亮==`、`- [ ]` 任务列表、`[[` 链接、Ctrl+Shift+K 之类的自定义键位。
- **块没有稳定标识。** 只有图片和引用节点带 `nodeID`，标题和段落没有，所以位置标识仍要自己想办法。

### 与 PDF 阅读器共享标注快捷键

**已实现**，见下面“标注工具的实现”。以下是设计时读到的情况。

PDF 阅读器的逻辑在上游 `zotero/reader` 的 `src/common/keyboard-manager.js`：

- `Alt+1` 切换高亮工具，`Alt+2` 下划线，`Alt+3` 便签，`Alt+4` 到 `Alt+7` 是文字、图片、
  墨迹、橡皮（仅 PDF）；`Alt+8`（PDF）循环切换颜色。
- 工具激活时，按 `1` 到 `8` 直接选颜色，顺序是黄、红、绿、蓝、紫、洋红、橙、灰
  （`defines.js` 的 `ANNOTATION_COLORS`）。
- 工具激活后，用鼠标选中文字就自动生成标注，不用再点按钮。

笔记编辑器这边的现状：

- 有 `backgroundColor`（高亮）、`underline`、`textColor` 三种标记，各 8 色，都靠工具栏或调色板
  用鼠标设置，**没有快捷键**，也没有“工具模式”。
- 高亮色的顺序与阅读器不同（红、橙、黄、绿、紫、洋红、蓝、灰），色值也不同：阅读器是不透明色，
  笔记里是带 `80` 透明度后缀的色。要共享快捷键，需要先统一“第几个数字对应哪个颜色”。
- 选中即应用，需要监听选区变化并发 ProseMirror 事务，属于第二档（要进 iframe）。
- 快捷键冲突：笔记编辑器里数字键和 `Alt+数字` 都用于输入或没有绑定，需要“工具模式”才能让
  `1` 到 `8` 不变成输入字符，进入模式后要有明显的界面提示，退出键也要定好。

### 标注工具的实现

| 键 | 作用 |
| --- | --- |
| `Alt+1` / `Alt+2` | 打开高亮 / 橡皮工具；再按同一个键关闭 |
| `1`–`4`（高亮工具开启时） | 选颜色：黄、红、绿、蓝，与阅读器里 `1`–`4` 同色同序 |
| 鼠标选中文字（高亮） | 把当前颜色应用到选区；选区已有颜色时，按数字键会改成新颜色 |
| 鼠标选中文字，或点一下（橡皮） | 清除选区（点击时是光标所在的那一段）的高亮、彩色下划线和文字颜色 |
| `Esc` | 关闭工具 |

- 笔记编辑器自带的键位里**没有**清除格式的快捷键；橡皮工具对应阅读器里的橡皮。
- 没有下划线工具：下划线太细，不适合做标注。已有的彩色下划线（PDF 标注带来的）由
  `note-editor.css` 加粗显示，橡皮也能清除。
- 只有 4 色：阅读器的 8 色里只取前 4 个。笔记里的高亮是带 `80` 透明度后缀的色，所以用的是
  编辑器自己的色值（`#ffd40080` 等），不是阅读器的不透明色；Obsidian 外观样式已经把这几个色
  映射成不透明填充。
- 不注入脚本：编辑器内核的 `pluginState.highlightColor` / `underlineColor` / `textColor` 已经有
  作用于当前选区的 `setColor` / `removeColor`，经 `wrappedJSObject` 调用即可。键盘和鼠标监听挂在
  iframe 的 `document` 上，工具开启时左下角有一个徽标显示工具和颜色。
- 高亮工具开启时数字键被占用，输入不了 `1`–`4`；按 `Esc` 或再按同一个 `Alt+数字` 退出。
  橡皮不占用数字键。
- 偏好 `extensions.zotero.unizero.noteEditor.tools` 可整体关闭。只读编辑器不挂载。
- 松开鼠标后，ProseMirror 的选区状态会稍晚于 DOM 选区，所以高亮按 0、40、120ms 各试一次，
  橡皮等 60ms。在 Windows 上验证过；其他平台上 `Alt+数字` 是否被主窗口抢走没有查。

### Obsidian 外观的参考

用户 vault 的 `.obsidian/snippets` 里，`appearance.json` 启用的有：`scheme.css`（正文、粗体、
斜体、行内代码和 H1 到 H6 的配色与字号，亮暗各一套）、`highlight-colors.css`（六色高亮用不透明
的 `oklch` 色，圆角）、`list spacing.css`。启用清单里还有 `zotero icon`、`my-annotations`、
`extended-colorschemes`、`scheme_副本`，但 snippets 目录里没有这几个文件。`段落首行缩进.css`、
`表格优化.css`、`预览模式优化-空白行-行间距.css`、`图片大小.css` 在目录里但没有启用，没有搬。

这些选择器针对 Obsidian 的 DOM（`.markdown-rendered`、`.cm-s-obsidian`），已经改写成
`.primary-editor` 下的选择器，放在 `addon/chrome/content/styles/note-editor.css`，由
`src/zotero/noteEditor.ts` 注入每个笔记编辑器的 iframe。隐藏偏好
`extensions.zotero.unizero.noteEditor.style` 为 false 时不注入。

状态：已实现，在 Zotero 里验证过，效果符合预期，深浅色和字号修改后样式仍在。

### 对 UniZero 的判断

- **成本分两档。** 第一档不进 iframe：右键菜单、通过 iframe 的 `document` 滚动、复制链接。
  第二档要进 iframe 注入脚本：粘贴插件、表格插件、`/` 命令。第二档需要把脚本单独打包再注入，
  生命周期里每个已打开的编辑器都要清理，Zotero 升级时最容易坏。
- **跳转不一定要碰 ProseMirror。** 编辑器根节点的直接子元素对应顶层块，BN 的图片预览也是直接用
  `_iframeWindow.document.querySelector(".primary-editor")`。滚动可以只操作 DOM。已验证（见下）。
- **打开着的笔记不能直接改 HTML。** BN 往打开的笔记里插入内容时，是通过编辑器发 ProseMirror
  事务，而不是 `setNote` 再保存，避免和编辑器里的内容冲突。“注入 PDF 高亮”作为编辑器的一个
  命令，比作为独立命令更合适，原因就在这里。

### 大纲侧栏的实现

只有标签页里的编辑器（有 `_tabID`）有大纲；项目面板里的太窄。面板是注入编辑器 iframe 的
`<aside>`，放在窗口左侧、`.editor-core` 所在的容器里，打开时给 `.editor-core` 留出左边距。这样不用补丁
`note-editor` 元素，也不用 XUL 分隔条，卸载时只要删掉面板、断开监听。代价是：宽度固定
（240px，不能拖），窗口窄于 640px 时隐藏，开关状态是所有笔记标签页共用的一个偏好。

- 条目是顶层块里的 h1–h6，缩进按外层标题的数量算（跳级也只缩一层）；点击条目用
  `scrollIntoView` 滚到那一块。
- 笔记变化用 `MutationObserver` 观察，250ms 防抖，条目没变就不重绘；当前章节按滚动位置算。
- 偏好 `extensions.zotero.unizero.noteEditor.outline`（总开关）和 `….outline.open`（是否展开）。
- 面板的 `top` 取 `.editor-core.offsetTop`，躲开编辑器自带的工具栏；`.editor-core` 上的
  `margin-left` 把正文让出来。两点都在 Zotero 里验证过。

### 在真实 Zotero 里验证过的事（2026-10-14）

1. `Zotero.Notes._editorInstances` 存在，`Zotero.Notes.getByTabID` 是函数，每个实例有
   `_iframeWindow`。
2. 编辑器根节点 `.primary-editor`（class 为 `ProseMirror primary-editor`）的直接子元素和
   ProseMirror 的顶层块一一对应：一条 281 块的笔记，DOM 子元素也是 281 个，另一条 14 对 14。
   所以跳转只靠 DOM 就行。
3. 同一条笔记会有两个编辑器实例：项目面板里的没有 `_tabID`，标签页里的有。跳转只动有
   `_tabID` 的那个。
4. `light-dark()` 和 `oklch()` 都被支持，样式在 Zotero 里显示符合预期。
5. 右键菜单：给 `editor._popup` 的 `popupshowing` 加菜单项有效，复制的链接粘进 Obsidian 能点开
   并滚动到位置。
6. 大纲侧栏、标注工具的行为符合预期（见上面两节）。

还没验证：笔记打开时，外部保存新的 HTML 会发生什么。只有“注入 PDF 高亮”用得到，先不查。

第 1、2 项的探针已经实现：在 Zotero 的 Tools → Developer → Run JavaScript 里运行
`return JSON.stringify(await Zotero.UniZero.api.noteEditorProbe(), null, 2)`，打开着几个笔记就
报告几个编辑器的情况。Run JavaScript 只显示 `return` 的值，所以必须写 `return`。
