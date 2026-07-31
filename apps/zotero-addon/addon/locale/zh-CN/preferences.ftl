caption-refresh = 刷新
autoRefresh =
  .label = 打开阅读器时自动刷新参考文献，以下条目类型除外






caption-tip = 浮窗
isShowTip-start = 
  .label = 鼠标在参考文献上停留
isShowTip-end = 毫秒后显示悬浮窗

ctrlClickTranslate = 
  .label = 浮窗内，ctrl点击文字翻译

shadeMillisecond-start = 浮窗显示/消失透明度渐变
shadeMillisecond-end = 毫秒

removeTipAfterMillisecond-start = 最后，在
removeTipAfterMillisecond-end = 毫秒后自动消失

tipBackgroundColor = 背景色
tipTitleColor = 标题色




caption-related = 关联
loadingRelated = 
  .label = 关联文献面板显示推荐关联文献


caption-link = 链接
clickLink-start = 
  .label = 点击链接跳转于
clickLink-splitHorizontally = 
  .label = 横向
clickLink-splitVertically = 
  .label = 竖向
clickLink-end = 分割窗口
hoverLink = 
  .label = 悬停链接显示浮窗




caption-save = 储存
saveAPIReferences = 
  .label = 储存 API 源参考文献（DOI 路线）
saveCitations = 
  .label = 储存引用列表
save-note = 已储存的列表会直接复用，不再重新查询；需要更新时点区块里的刷新。

caption-match = 匹配
notInLibarayOpacity-start = 匹配本地条目，并且以透明度
notInLibarayOpacity-end = 显示不在我的文库的条目

caption-api = 数据源
sourceOrder-note = 参考文献优先按 DOI 直连获取（OpenAlex → Crossref → Semantic Scholar）。没有 DOI 的条目回落到转换时抽取的参考文献。
semanticScholarApiKey = Semantic Scholar API key
semanticScholarApiKey-note = 可选。不填则匿名调用，限速约每秒 1 次，且经常返回 429。

caption-runtime = 本地服务
runtime-note = 转换 PDF 需要本地 Python 运行时。装好 unizero-runtime 之后两个路径都可以留空。
runtime-pythonPath = Python 路径
runtime-pythonPath-input =
  .placeholder = 留空 = 自动检测
runtime-serverScript = server.py 路径
runtime-serverScript-input =
  .placeholder = 留空 = 自动查找已安装的 unizero-runtime
runtime-port = 端口
runtime-port-note = 下次启动服务时生效
runtime-autoStart =
  .label = 启动 Zotero 时在后台启动服务
runtime-autoStopOnQuit =
  .label = 退出 Zotero 时停止服务（只停插件自己启动的）

caption-conversion = 转换
conversion-mdSnapshot =
  .label = 转换后把 Markdown 副本存入条目
conversion-note = 副本随 Zotero 同步、换机器能看，代价是每次重新转换都会覆盖它。

conversion-obsidianVault = Obsidian 仓库
conversion-obsidianVault-input =
  .placeholder = 仓库名
conversion-obsidianVault-note = 填写后「在 Obsidian 中打开」按笔记的 uid 跳转，在仓库内改名或移动都不会失效。需要 Advanced URI 插件。留空则按文件路径打开。

caption-sync = WebDAV 同步
sync-note = 当前同步 Project、Board、节点、连线和删除 tombstone；针对坚果云 WebDAV 设计。
sync-webdav-url = WebDAV 地址
sync-webdav-username = 账号邮箱
sync-webdav-password = 应用密码
sync-webdav-password-note = 请在坚果云生成第三方应用密码。选择记住后，它只保存在 Zotero 的安全密码管理器中，不参与同步。
sync-remember-password =
  .label = 在此设备上安全记住应用密码
sync-auto =
  .label = 自动同步
sync-interval = 频率
sync-interval-30 = 每 30 分钟
sync-interval-60 = 每小时
sync-interval-180 = 每 3 小时
sync-interval-360 = 每 6 小时
sync-notifications = 后台通知
sync-notifications-errors = 仅错误
sync-notifications-all = 所有结果
sync-notifications-none = 不通知
sync-now = 立即同步
sync-status-running = 正在同步…
sync-status-done = 完成：上传 { $uploaded }，下载 { $downloaded }，合并 { $merged }，剩余批次 { $remaining }
sync-status-deferred = { $skipped } 个文档需要更新版本的 UniZero，已保留在服务器上。
sync-status-error = 同步失败：{ $message }
sync-status-password-save-error = 同步已完成，但应用密码未能保存。
sync-status-last-success = 上次同步：{ $time }
sync-status-last-error = 上次同步失败：{ $message }
