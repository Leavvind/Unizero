caption-tip = 浮窗
isShowTip =
  .label = 鼠标停在参考文献上时显示详情浮窗


caption-save = 储存
saveAPIReferences = 
  .label = 储存 API 源参考文献（DOI 路线）
saveCitations = 
  .label = 储存引用列表
save-note = 已储存的列表会直接复用，不再重新查询；需要更新时点区块里的刷新。

caption-match = 文库匹配
notInLibarayOpacity-start = 不在我的文库中的参考文献，不透明度
notInLibarayOpacity-end =

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

conversion-defaultTemplate = 默认模板
conversion-defaultTemplate-note = 转换未指定模板时使用：Obsidian 设为「Zotero 默认」时、MCP 服务、以及论文运行时未启动时的条目菜单。列表显示正在运行的运行时中的模板。
