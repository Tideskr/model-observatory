# 后端 API 草案

前端当前使用模拟数据。后端实现时建议从以下版本化边界开始，所有写操作要求 CSRF 防护、速率限制和审计事件。

## 公开读取

- `GET /api/v1/dashboard`
- `GET /api/v1/providers/{slug}`
- `GET /api/v1/registry?status=stable|beta`
- `GET /api/v1/registry/{id}`
- `GET /api/v1/transparency/events`

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

## Registry 与审核

- `POST /api/v1/registry/proposals`
- `GET /api/v1/registry/proposals/{id}`
- `POST /api/v1/registry/proposals/{id}/reviews`
- `POST /api/v1/registry/proposals/{id}/replications`
- `POST /api/v1/registry/proposals/{id}/promote`
- `POST /api/v1/registry/versions/{id}/revoke`

所有状态迁移由服务端权限和状态机校验，客户端提交的角色、评级或签名状态不可直接信任。
