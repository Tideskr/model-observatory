# Model Observatory Runner

Runner 是兼容 Model Observatory 私有检测协议的本机执行服务。它只监听 `127.0.0.1`，API key 直接从浏览器交给本机 Runner，再由 Runner 请求待测接口；网页所属服务器不会收到该 key。

Runner 4.2 采用单一界面架构：所有配置、实时进度和报告都在调用它的网站中显示，发行包不再附带另一套网页，也不绑定特定网站。

## 快速开始

要求 Python 3.10 或更新版本。

- Windows：解压后双击 `START-WINDOWS.cmd`。
- macOS / Linux：运行 `chmod +x start.sh && ./start.sh`。
- 已通过 pip 安装：运行 `model-observatory-runner serve`。

启动器只会启动本机服务并等待兼容网站连接。运行检测期间请保留终端窗口。

## 常用命令

```text
model-observatory-runner serve --port 8756
model-observatory-runner doctor
model-observatory-runner --version
```

运行数据默认保存在用户数据目录，不会写入解压目录。可用 `--data-dir PATH` 覆盖。API key 只存在于当前进程内存，不写入报告、SQLite 或日志。

Native Codex 请求格式需要本机安装 Node.js；Normal 格式不需要。`doctor` 会显示当前机器是否满足这些条件。

## 安全边界

- 服务固定绑定 `127.0.0.1`，不会监听局域网或公网地址。
- 接受任意合法网页 Origin，并为浏览器回环访问返回所需的 CORS/PNA 响应头。
- 报告仅包含脱敏观测，不包含 API key 或原始回答。
- 建议始终使用短期、限额、限定模型、可撤销的 key。
- Juice 与行为指纹都是检测证据，不是底层路由的密码学证明。

## 从源码安装

```bash
python -m pip install .
model-observatory-runner serve
```

测试：

```bash
python -m unittest discover -s tests -v
```

旧版算法说明与变更记录保留在 `docs/legacy/`，不会进入面向普通用户的发行包根目录。
