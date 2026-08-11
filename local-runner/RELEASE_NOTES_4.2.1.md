# Model Observatory Runner 4.2.1

本版本将指纹实测可靠度作为独立、版本化证据接入报告。

- Runner 与项目服务器统一升级到 `stage-c-trusted-fingerprint-v4` 评分发行包。
- 模型相对匹配度不再被解释为后验置信度。
- 强匹配结果新增观察精度、样本数、95% Wilson 区间、覆盖率和校准范围。
- 高档 Terra/Luna 因缺少标签样本而明确标记为暂无校准数据。
- 没有有效指纹证据 family 时不再默认返回 Sol winner。

Windows 用户下载 `model-observatory-runner-4.2.1-windows.zip`，解压后双击 `START-WINDOWS.cmd`。

macOS / Linux 用户下载通用 zip，解压后运行 `chmod +x start.sh && ./start.sh`。
