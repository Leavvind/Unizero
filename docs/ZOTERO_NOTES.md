# Zotero 笔记层：维护说明

UniZero 已自行实现 `zotero://note` 链接和编辑器增强，不再依赖 Better Notes（下称 BN）。
功能与使用方式见 [add-on README](../apps/zotero-addon/README.md)，未完成事项见
[ROADMAP](ROADMAP.md#zotero-notes)。本文仅保留维护约束和验证边界。

转换后的论文正文不再写成 Zotero 笔记：它以 Markdown 附件（Raw）保存在条目下，用系统的
Markdown 程序打开和编辑，见 add-on README。原 Markdown → 笔记 HTML 转换器、长笔记拆分
和 `publish.zotero-note` 模块已删除；已有用户库里带 `unizero:raw-note` 标签的旧笔记
保留为普通笔记，代码不再读取或修改它们。

## 来源与许可

笔记链接沿用 BN 的 URL 格式和注册方式，见 [NOTICE](../NOTICE)。

## 1. 链接层：`zotero://note`

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

## 2. 反向转换：笔记 HTML → Markdown（暂缓）

尚未实现，普通复制粘贴已能保留大多数格式。若恢复这项工作，纯转换仍归 `src/notes/`，
Zotero 引用和标注的解析归 Zotero 适配层。原设计需要把引用转为 `@libraryID/itemKey`、
高亮转为带 PDF 回链的引用块，并保留 `zotero://note` 链接。入口和桥接接口尚未确定，
这些设想不属于当前功能。

## 3. 编辑器增强

入口为 `apps/zotero-addon/src/zotero/noteEditor.ts`，导航、大纲和选区快捷键分别在
同目录的 `noteNavigation.ts`、`noteOutline.ts` 和 `noteShortcuts.ts`（阅读器一侧在
`readerShortcuts.ts`）；纯逻辑在 `src/notes/`。
样式在 `apps/zotero-addon/addon/chrome/content/styles/`。

- 编辑器接入依赖私有 `Zotero.Notes.registerEditorInstance`、`_editorInstances`、
  `_iframeWindow` 和 `_popup`。初始化需等待 `_initPromise`，支持已有实例和重新
  初始化，重复挂载不得叠加监听。关闭时清理样式、菜单、监听、大纲和快捷键；如果其他
  add-on 又包装了注册函数，保留在调用链里的 UniZero 包装器必须失效。
- 样式和大纲注入编辑器 iframe，大纲只在笔记标签页挂载。大纲不补丁自定义元素，
  卸载时移除面板和布局调整，并断开观察器。
- 选区快捷键（macOS 上 `Cmd+Option+B/R/P` 蓝/红/紫高亮，`Cmd+Option+\` 清除格式；
  Windows 上用 `Ctrl+Alt`）供鼠标按键绑定：鼠标驱动只区分应用，不区分 Zotero 的
  窗口，所以同一个键在笔记和阅读器里含义相同。颜色取自阅读器，笔记编辑器共用。笔记里通过 `wrappedJSObject` 调用编辑器内核 `highlightColor.setColor`，
  清除格式用 ProseMirror 事务移除除链接外的所有 mark，不注入脚本，只挂载到可编辑实例。
  阅读器里在公开事件 `renderTextSelectionPopup` 时给视图挂监听，按键时临时改高亮工具
  颜色并向视图发送阅读器自带的 `Ctrl+Option+1`，随后恢复颜色；依赖私有的
  `_internalReader`、`_tools` 和视图 `_iframeWindow`，需在真实 Zotero 中检查。
  视图窗口经 `wrappedJSObject` 取得，Xray 已被解除：页面代码不能回调特权代码，
  所以挂监听和构造事件前必须 `unwaiveXrays`，否则监听永远不会触发。
  按键所在的视图就是持有选区的视图，按键从阅读器自身界面来时才退回最近使用的视图。
  阅读器界面里的文本框（批注评论、搜索）保留按键；Windows 上 AltGr 同样报告
  Ctrl+Alt，须用 `getModifierState("AltGraph")` 排除，否则会吞掉 AltGr 字符。
  开关在每次按键时读取，按住不放的重复按键只拦截不执行。
- **向打开中的笔记插入内容应通过编辑器事务。** 外部 `setNote` / 保存可能与编辑器
  状态冲突。

Markdown 粘贴和表格列宽调整尚未实现；它们需要单独处理编辑器插件接入与清理，
不能从转换器或现有样式推断为已支持。

## 验证边界

以下为此前记录的验证结果，不表示本次文档整理重新执行了检查：

- 截至 2026-10-14，真实 Zotero 中已验证编辑器样式、位置跳转、复制链接和大纲。当时的
  `Alt+数字` 标注工具已撤回，由选区快捷键取代。
- 用户于 2026-10-14 确认群组库笔记链接已完成验证。
- 笔记和阅读器中的选区快捷键尚未验证。外部保存打开中笔记的 HTML 也未验证。

编辑器兼容性排查可在 Zotero 的 Tools → Developer → Run JavaScript 中运行：

```js
return JSON.stringify(await Zotero.UniZero.api.noteEditorProbe(), null, 2)
```

探针报告已打开的编辑器实例及其能力；Run JavaScript 只显示 `return` 的值。
