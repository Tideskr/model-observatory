# 后端实现说明

## 已实现边界

- Fastify 版本化 API、TypeBox 请求/响应契约、统一 problem 错误和 OpenAPI。
- PostgreSQL 迁移、`FOR UPDATE SKIP LOCKED` worker 租约、租约版本栅栏、逐任务调用预算、任务事件与不可变报告。
- 私有检测 quote、创建、Bearer 能力令牌、SSE、取消、报告和逻辑删除。
- HTTPS 443 目标限制、DNS/IP SSRF 校验、固定解析地址、禁止重定向、超时和 1 MiB 响应上限。
- Normal Responses 执行器、2,048-token 硬输出上限（预计可见输出按 40 token）、逐项保存归一化观测的 Legacy 兼容评分器。
- API 捐赠 quote、幂等创建、AES-256-GCM 信封、隔离状态、状态查询和撤销。
- Dashboard/Provider/Registry 公开读模型，以及内容寻址的 GitOps Registry 提案。

## Legacy 判据数据库

导入源固定为：

- `Legacy/gpt56_vnext/baselines/runtime_catalog.json`
- `Legacy/gpt56_vnext/baselines/trusted_likelihood_v2.json`

导入器固定校验两份受信源文件的 SHA-256，并验证 schema、每个固定 prompt/developer prompt 的 SHA-256、baseline 内容 hash 与 calibration runtime signature。规范化结果包含 11 个探针、15 个模板、27 个模型/effort 签名、12 个拟合单元、4 个校准契约和 6 条有序 verdict 规则。

生产运行时只读取数据库中的不可变 release，不执行 `Legacy/` 内代码。Registry 提案也不能原地覆盖已校准 prompt；修改必须生成新版本、重新校准并经 GitOps 审核。

## 尚未开放

- 远程 Native 执行；当前只允许本地 runner。
- 代理凭据自动接收与执行。
- OIDC 贡献者身份、多人 review/replication/promote、Ed25519 阈值签名和公开部署。
- PostgreSQL 实例上的迁移演练；当前开发机器未安装 PostgreSQL 或 Docker，已由内存契约测试覆盖应用层。
