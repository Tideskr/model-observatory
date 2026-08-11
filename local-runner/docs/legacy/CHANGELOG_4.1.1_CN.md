# GPT-5.6 混用检测器 4.1.1 更新说明

此版本在 4.1.0 检测与评分核心上增加 Model Observatory 本地 runner 兼容层：

- 固定监听 `127.0.0.1:8756`，供 `https://check.skr.moe` 私有检测页面发现。
- 提供 quote、创建任务、SSE 进度、取消和脱敏报告接口。
- 支持 Normal、Native Codex 与固定 32K 上下文配置转换。
- 跨域来源仅允许 `check.skr.moe` 与本机页面，并响应 Private Network Access 预检。
- API key 仍只保存在本地检测进程内存中，不写入报告、SQLite 或日志。
- 将一次任务的重试上限与 Model Observatory 前端统一为 3。

4.1.0 的探针、可信基线和七状态评分语义保持不变。
