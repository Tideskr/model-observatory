# Model Observatory Runner 4.2.0

本版本将 Runner 重构为站点无关的本机执行服务。

- 不再附带独立网页，也不绑定或自动打开特定网站。
- 接受任意兼容网页连接，固定监听 `127.0.0.1:8756`。
- 新增成功、失败、执行中、HTTP 尝试和重试等实时进度。
- 报告新增逐请求脱敏观测、Profile 汇总和详细错误字段。
- Runner 与项目服务器统一使用 `stage-c-trusted-fingerprint-v3` 评分发行包。
- 新增标准 Python wheel、跨平台包、Windows 一键包和统一校验文件。

Windows 用户下载 `model-observatory-runner-4.2.0-windows.zip`，解压后双击 `START-WINDOWS.cmd`。

macOS / Linux 用户下载通用 zip，解压后运行 `chmod +x start.sh && ./start.sh`。
