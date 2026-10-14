# Zotero 笔记层：维护说明

UniZero 已自行实现 Raw 笔记转换、`zotero://note` 链接和编辑器增强，不再依赖
Better Notes（下称 BN）。功能与使用方式见
[add-on README](../apps/zotero-addon/README.md)，未完成事项见
[ROADMAP](ROADMAP.md#raw-note)。本文仅保留维护约束和验证边界。

## 来源与许可

Markdown 转换器移植自 BN 3.3.3（commit `4215a88`）,采用AGPL-3.0 见 [NOTICE](../NOTICE)。
笔记链接沿用其 URL 格式和注册方式。

## 1. 转换层：Markdown → 笔记 HTML

- 纯转换在 `apps/zotero-addon/src/notes/markdownToNote.ts`，不调用 Zotero API；
  笔记创建、替换和拆分编排在 `apps/zotero-addon/src/zotero/rawNoteAdapter.ts`。
  runtime 只产出 Markdown，Zotero 笔记由 add-on 创建。
- 移植路径为 `md2remark` → `remark2rehype` → `rehype2note`。公式、表格和列表的
  输出遵循 Zotero note-editor 格式，调整时需对照上游规则及测试。图片丢弃，保留 alt
  文字；MinerU 的 TeX 直接转换，不需要解析 KaTeX HTML。
- **bundle 加载时没有 `document`。** `apps/zotero-addon/scripts/build.mjs` 的 alias
  将 `decode-named-character-reference` 切换到不依赖 DOM 的版本。删除 alias 或新增
  浏览器依赖可能使整个 add-on 无法启动，Node 单元测试无法覆盖这个问题。
- 转换目前在主线程运行；此前最长书籍实测约 2.5 秒，期间会阻塞 UI。

### 长笔记与 Replace

Zotero 同步上限按 HTML 字符数计，包含标签，不按字节计。拆分阈值和目标大小由
`rawNoteAdapter.ts` 的 `NOTE_MAX_CHARS` / `NOTE_PART_CHARS` 定义。切分逻辑在
`apps/zotero-addon/src/notes/splitMarkdown.ts`，不得切进代码块或块公式；无法拆开的
单个大段落或表格可能仍超限，不能保证所有分段都能同步。

Raw 笔记的所有权由 `unizero:raw-note` 标签确定。分段开头的 `Part i/n` 进一步用于
识别和排序旧分段；Replace 复用已有分段，只清理多余的已标记分段，不得依据显示标题
删除用户笔记。Skip 保留已有笔记及用户编辑，不重新转换。

## 2. 链接层：`zotero://note`

实现位于 `apps/zotero-addon/src/zotero/noteLinks.ts`，位置语义在
`apps/zotero-addon/src/notes/noteLocation.ts`。

- 用户库使用 `zotero://note/u/<key>/`，群组库使用 `zotero://note/<groupID>/<key>/`。
  群组路径必须使用 `groupID`，不能替换成设备本地的 `libraryID`。
- `notes.links` 启动时注册协议处理器，关闭时移除。注册依赖私有 `_extensions` 表，
  卸载时恢复被替换的旧值；Zotero 升级后需人工检查。
- `line` 是从 0 起的顶层块序号；`section` 是标题文字，`n` 是从 1 起的同名标题
  次序。优先匹配 `section`，失败再用 `line`。编辑会改变块序号，改标题或同名标题
  次序也会影响章节链接；它们不是稳定锚点，也不标记块内的文字范围。
- 同一笔记可能有预览和标签页两个编辑器实例。跳转只操作有 `_tabID` 的实例，
  通过 `.primary-editor` 的直接子元素定位顶层块。
- Obsidian 的 `openRaw` 每次只发送一个 URL：优先 `links.rawNoteOpen`，否则选中
  笔记。并发发送打开和选中链接会竞争，后完成的 `zotero://select` 可能盖掉笔记标签页。

## 3. 反向转换：笔记 HTML → Markdown（暂缓）

尚未实现，普通复制粘贴已能保留大多数格式。若恢复这项工作，纯转换仍归 `src/notes/`，
Zotero 引用和标注的解析归 Zotero 适配层。原设计需要把引用转为 `@libraryID/itemKey`、
高亮转为带 PDF 回链的引用块，并保留 `zotero://note` 链接。入口和桥接接口尚未确定，
这些设想不属于当前功能。

## 4. 编辑器增强

入口为 `apps/zotero-addon/src/zotero/noteEditor.ts`，导航、大纲和标注工具分别在
同目录的 `noteNavigation.ts`、`noteOutline.ts` 和 `noteTools.ts`；纯逻辑在 `src/notes/`。
样式在 `apps/zotero-addon/addon/chrome/content/styles/`。

- 编辑器接入依赖私有 `Zotero.Notes.registerEditorInstance`、`_editorInstances`、
  `_iframeWindow` 和 `_popup`。初始化需等待 `_initPromise`，支持已有实例和重新
  初始化，重复挂载不得叠加监听。关闭时清理样式、菜单、监听、大纲和工具；如果其他
  add-on 又包装了注册函数，保留在调用链里的 UniZero 包装器必须失效。
- 样式和大纲注入编辑器 iframe，大纲只在笔记标签页挂载。大纲不补丁自定义元素，
  卸载时移除面板和布局调整，并断开观察器。
- 标注工具通过 `wrappedJSObject` 调用编辑器内核颜色插件的 `setColor` / `removeColor`，
  不注入脚本。工具仅挂载到可编辑实例。DOM 选区与 ProseMirror 选区更新时间不同，
  鼠标操作后的延迟应用需在真实编辑器中检查。
- 高亮工具使用编辑器自身的四种半透明色，数字顺序与 PDF 阅读器的前四色一致。
  高亮模式占用数字键 `1`–`4`，必须保留工具徽标和退出方式；橡皮清理高亮、彩色
  下划线和文字颜色。
- **向打开中的笔记插入内容应通过编辑器事务。** 外部 `setNote` / 保存可能与编辑器
  状态冲突，不能直接沿用创建 Raw 笔记的路径。

Markdown 粘贴和表格列宽调整尚未实现；它们需要单独处理编辑器插件接入与清理，
不能从转换器或现有样式推断为已支持。

## 验证边界

以下为此前记录的验证结果，不表示本次文档整理重新执行了检查：

- 转换器曾与 BN 对比 85 份 MinerU Markdown，81 份一致，其余差异记录为实体或标签
  的等价处理及对比脚本近似；单元测试期望值也曾用 BN 核对。
- 截至 2026-10-14，真实 Zotero 中已验证公式、表格、页面链接、Skip，以及编辑器
  样式、位置跳转、复制链接、大纲和 Windows 标注工具。
- 用户于 2026-10-14 确认 Replace 重建已有笔记及群组库笔记链接已完成验证。
- 真实长文档各分段同步及替换、其他平台的 `Alt+数字` 尚未验证。外部保存打开中
  笔记的 HTML 也未验证。

编辑器兼容性排查可在 Zotero 的 Tools → Developer → Run JavaScript 中运行：

```js
return JSON.stringify(await Zotero.UniZero.api.noteEditorProbe(), null, 2)
```

探针报告已打开的编辑器实例及其能力；Run JavaScript 只显示 `return` 的值。
