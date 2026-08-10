# 后端 API 契约

API 统一挂载在 `/api/v1`。公开读取带版本元数据与缓存策略；带凭据写入使用同源 JSON、严格 CORS、速率限制、短期签名 quote 和能力令牌。前端在公开数据库为空时保留显式模拟数据回退。

## 公开读取

- `GET /api/v1/dashboard`
- `GET /api/v1/providers/{slug}`
- `GET /api/v1/registry?status=stable|beta`

响应必须包含 `generated_at`、`data_version`、`method_version` 和缓存策略。公开证据需要服务端脱敏。

## 私有检测

- `POST /api/v1/private-runs/quote`：返回目标、探针数、预算和披露版本。
- `POST /api/v1/private-runs`：创建任务，凭据放在专用一次性字段，不进入常规任务对象。
- `GET /api/v1/private-runs/{id}/events`：SSE 进度；要求任务所有权令牌。
- `POST /api/v1/private-runs/{id}/cancel`
- `GET /api/v1/private-runs/{id}/report`
- `DELETE /api/v1/private-runs/{id}`

任务和报告不能只凭可枚举 ID 访问。失败、取消、不完整和超时必须是显式终态，不能计为正常检测样本。

## 捐赠

- `POST /api/v1/donations/quote`
- `POST /api/v1/donations`
- `POST /api/v1/donations/{id}/revoke`
- `GET /api/v1/donations/{id}/status`

创建成功只返回凭据指纹尾部和一次性撤销令牌。撤销令牌只存 hash。

当前实现只接收 `kind=api`；代理和商家通道仍走人工流程。API key 存入 AES-256-GCM 临时信封，捐赠业务记录只有信封句柄和 HMAC 指纹尾部。新记录固定为 `quarantined`，撤销或到期即删除信封。

## Registry 与审核

- `POST /api/v1/registry/proposals`
- `GET /api/v1/registry/proposals/{id}`

提案由服务端校验字段、探针状态和 Legacy prompt 锁定规则，计算内容 hash，固定保存为 `gitops_pending` 并返回预填 GitHub issue。API 不接受客户端提交的角色、评级、审核或签名状态；review、replication、promote 和 revoke 将在 OIDC 与多人签名边界完成后另行开放。
