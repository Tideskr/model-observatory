# Model Observatory Frontend

React + TypeScript + Vite 前端。公开页面优先读取后端，在空数据库或 API 不可用时显式回退到 `src/data.ts` 的模拟数据。API 捐赠、Registry 提案和私有检测均已接通版本化后端；私有凭据只保存在页面内存中，创建成功后立即清空。

开发服务器会把 `/api` 代理到 `http://127.0.0.1:8787`。分离部署时设置 `VITE_API_ORIGIN`；所有读写请求都会使用该 origin。

```bash
npm install
npm run dev
```

可用检查：

```bash
npm run lint
npm run build
```

产品、安全和社区治理文档位于仓库根目录的 `docs/`。
