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
  .label = 需要时自动启动服务
runtime-autoStopOnQuit =
  .label = 退出 Zotero 时停止服务（只停插件自己启动的）

caption-conversion = 转换
conversion-mdSnapshot =
  .label = 转换后把 Markdown 副本存入条目
conversion-note = 副本随 Zotero 同步、换机器能看，代价是每次重新转换都会覆盖它。
