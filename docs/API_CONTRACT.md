# 后端 API 契约

API 统一挂载在 `/api/v1`。公开读取带版本元数据与缓存策略；带凭据写入使用同源 JSON、严格 CORS、速率限制、短期签名 quote 和能力令牌。前端在公开数据库为空时保留显式模拟数据回退。

## 公开读取

- `GET /api/v1/dashboard`
- `GET /api/v1/providers/{slug}`
- `GET /api/v1/registry?status=stable|beta`

响应必须包含 `generated_at`、`data_version`、`method_version` 和缓存策略。公开证据需要服务端脱敏。

## 私有检测

- `POST /api/v1/private-runs/quote`：按提交的价格假设返回目标、逻辑请求数、含重试的最大调用/token/费用和披露版本。
- `POST /api/v1/private-runs`：要求 `Idempotency-Key`，凭据放在专用一次性字段，不进入常规任务对象。
- `GET /api/v1/private-runs/{id}/events`：SSE 进度；要求任务所有权令牌。
- `POST /api/v1/private-runs/{id}/cancel`
- `GET /api/v1/private-runs/{id}/report`
- `DELETE /api/v1/private-runs/{id}`

任务和报告不能只凭可枚举 ID 访问。失败、取消、不完整和超时必须是显式终态，不能计为正常检测样本。worker 每次上游调用前持久化占用一次预算，预计可见输出按 40 token、实际执行硬上限为 2,048 token；租约恢复只重做没有脱敏观测的 job。

## 捐赠

- `POST /api/v1/donations/quote`
- `POST /api/v1/donations`（要求 `Idempotency-Key`）
- `POST /api/v1/donations/{id}/revoke`
- `GET /api/v1/donations/{id}/status`

创建成功只返回凭据指纹尾部和撤销令牌。撤销令牌只存 hash；同一幂等请求重试会返回同一 donation 和同一可恢复令牌，不会创建第二份信封。

当前实现只接收 `kind=api`；代理和商家通道仍走人工流程。报价会按 `registry/providers.json` 精确匹配 hostname，并返回供应商的分组、倍率、检测模型和整轮成本；未登记域名返回 `provider_not_registered`。创建请求必须提交报价中的 `group_id`。

API key 存入 AES-256-GCM 长期信封，周期任务只使用可自动销毁的临时副本。新记录从 `quarantined` 开始，完成分组探测和全部配置模型的首轮 medium 检测后转为 `active`。状态响应包含阶段、逐请求进度、当前模型、分组归属、额度预留/实扣和脱敏错误。撤销或到期会删除长期及在途临时信封，并排除相关公开聚合。

公开模型指标使用最近 30 天窗口：真实性通过率只统计 `pass`/`fail` 的明确结论，可用率独立按成功请求数/尝试请求数计算；证据不足不进入真实性分母。

## Registry 与审核

- `POST /api/v1/registry/proposals`
- `GET /api/v1/registry/proposals/{id}`

提案由服务端校验字段、探针状态和 Legacy prompt 锁定规则，计算内容 hash，固定保存为 `gitops_pending` 并返回预填 GitHub issue。API 不接受客户端提交的角色、评级、审核或签名状态；review、replication、promote 和 revoke 将在 OIDC 与多人签名边界完成后另行开放。
