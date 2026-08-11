# Model Observatory

开放模型 API 观测站。持续比较官方接口与第三方提供商的模型行为，以可复核证据、覆盖范围和不确定性呈现结果。

> 当前状态：后端控制面与前端已接通，包括公开读模型、API 捐赠、Registry 提案和私有检测完整生命周期。公开页面在数据库无数据时显式回退到模拟数据；模拟结果不代表对任何真实提供商的检测结论。

## 为什么重建

原项目是一份针对单一模型族的本地检测器发布快照。新项目将范围扩展到多个模型、多个提供商、多个地区与多个独立证据来源，同时把社区贡献、凭据捐赠和抗投毒机制纳入产品设计。

原快照已完整迁移到 `Legacy/`，仅用于审计和迁移参考。经原作者许可，仓库只纳入后端所需的两份评分基线 JSON；含真实请求的旧服务与其余快照继续排除，不应暴露到公网。

## 产品范围

- Dashboard：按模型、提供商、测试模式、地区和证据来源查看近期观测结果。
- 私有检测：使用用户提供的临时凭据发起普通或 Native 检测，并生成私有报告。
- 捐赠：接受额度、测试账号、受限 API key 或自托管执行节点，支持到期和撤销。
- 社区数据库：像 Wiki 一样提交模型基线、探针和评分规则的版本化变更。
- 审核台：自动校验、独立复现、风险分级、签名发布和回滚。

## 信任原则

Model Observatory 不声称能“保证模型是真的”。提供商可能识别公开探针、对已知账号或测试节点选择性路由，任何单次通过都只能说明当时路径上未观察到异常。

正式展示遵循以下规则：

1. `vendor`、`donated`、`community` 三类证据分栏显示，不合并成简单票数。
2. 首页综合值以 `donated + community` 为准；`vendor` 单独展示且不进入综合值。新捐赠先进入隔离区，经过复核后才能形成 `donated` 证据。
3. 中心节点通过而分布式样本失败时，标记为“疑似选择性路由”，不下绝对结论。
4. 所有结论同时显示账号、节点、地区、网络、时间窗口和基线版本覆盖。
5. 严重历史证据不会因后续短期通过而自动消失。

完整设计见 [`docs/TRUST_AND_ANTI_POISONING.md`](./docs/TRUST_AND_ANTI_POISONING.md)。

## Native 检测与凭据

远程后端当前只执行 Normal 检测，且只保留归一化观测，不保留任意原始回答。Native 检测仍限制在本地 runner；在隔离执行器完成安全审计前，服务端拒绝远程 Native。

仅应使用短期、限额、可撤销、限定模型和来源的凭据。长期主密钥不属于推荐的捐赠方式。详见 [`docs/CREDENTIAL_AND_NATIVE_DISCLOSURE.md`](./docs/CREDENTIAL_AND_NATIVE_DISCLOSURE.md)。

本地 runner 源码位于 [`local-runner/`](./local-runner)，Release 提供可直接解压运行的包。runner 监听 `127.0.0.1:8756` 并与线上私有检测页面连接，API key 不经过项目服务器。

## 本地开发

需要 Node.js 22+ 和 npm 11+。开发模式可使用内存存储：

```bash
cd backend
npm install
npm run dev
```

另一个终端启动前端：

```bash
cd frontend
npm install
npm run dev
```

生产构建：

```bash
cd frontend
npm run build
```

## Docker 部署

根目录的 `Dockerfile` 会构建前后端单一应用镜像；`compose.production.yml` 同时运行 PostgreSQL、迁移任务、API 和 worker。复制 `deploy/.env.production.example` 并替换全部密钥后启动：

```bash
docker compose --env-file .env.production -f compose.production.yml up -d --build
```

容器端口默认只发布到宿主机 `127.0.0.1:18787`。`deploy/Caddyfile` 提供 `check.skr.moe` 的 HTTPS 反向代理配置。

`.github/workflows/deploy.yml` 会在 `main` 分支每次提交后通过受限 SSH 密钥触发生产部署。VPS 上的固定入口串行执行 `deploy/server-deploy.sh`，仅允许快进到远端 `main`，重新构建 Compose 服务并等待健康检查通过。

仅修改 `registry/providers.json` 的提交会走轻量发布：部署脚本不重建镜像或重启 API/worker，只校验并同步 Registry，运行中的进程通过 PostgreSQL 通知切换快照。包含其他文件的提交仍执行完整部署。

可视化 Registry 管理入口为 `/admin/registry`。创建一个仅安装到本仓库、具备 `Contents: write` 权限的 GitHub App，并将回调地址设置为 `https://check.skr.moe/api/v1/admin/auth/github/callback`；然后配置 `deploy/.env.production.example` 中的 `GITHUB_ADMIN_*`、数字形式的 `ADMIN_GITHUB_USER_IDS` 和随机 `ADMIN_SESSION_SECRET`。当前白名单为 `chen-006`、`hanlinwenyuan`、`Tideskr`（管理员）和 `imNachoNeko`。Web 发布会先生成 Git 提交，再热激活相同内容。

## 目录

```text
.
|-- Legacy/                 # 原项目发布快照，只读参考
|-- docs/                   # 产品、安全与社区治理文档
|-- backend/                # Fastify API、PostgreSQL 迁移、worker 与评分器
|-- frontend/               # React + TypeScript + Vite 前端
|-- local-runner/           # Python 本地检测器与前端兼容 API
`-- README.md
```

## 当前路线

- [x] 项目重命名与 Legacy 归档
- [x] 前端信息架构和交互原型
- [x] 抗投毒、凭据披露和社区数据库规范
- [x] 版本化 API、PostgreSQL 任务队列与 Normal 执行 worker
- [x] 能力令牌、AES-GCM 临时密钥信封与防篡改审计链
- [x] Legacy 判据数据库、导入校验与确定性评分器
- [x] API 捐赠隔离区、撤销令牌与 GitOps Registry 提案
- [ ] OIDC 贡献者身份、多人审核与签名发布
- [ ] 正式安全审计与公开部署

## License

新项目许可证尚未确定。`Legacy/gpt56_vnext/baselines/` 中两份评分基线经原作者许可复制并保留来源说明；其余 Legacy 内容仍沿用原有来源和约束，不属于新项目代码。
