# Provider domain registry

`providers.template.json` 是 `base_url` 到供应商归属关系的建议源格式。实际匹配只使用 URL 的规范化 hostname，不使用协议、路径或尾斜杠。

例如，以下地址都匹配 `api.relay-example.com`：

```text
https://api.relay-example.com
https://api.relay-example.com/v1
https://api.relay-example.com/v1/
```

## 字段

- `schema_version`：格式版本；结构变更时递增。
- `slug`：供应商稳定 ID，创建后不随展示名称改变。
- `name`：供应商展示名称。
- `kind`：与项目现有类型一致，取 `relay`、`official` 或 `official_proxy`。
- `domains[].hostname`：小写 ASCII hostname，不含协议、端口、路径或通配符。
- `domains[].role`：`primary` 或 `alias`；每个供应商必须恰好有一个 `primary`。
- `domains[].default_base_path`：该域名常用的 API 根路径，必须以 `/` 开头；它只用于展示或预填，不参与供应商匹配。
- `domains[].status`：`active` 或 `retired`。停用域名仍保留归属，避免历史报告失去供应商关联。

## 校验约束

1. `slug` 在整个文件中唯一。
2. 规范化后的 `hostname` 在整个文件中唯一，不能出现在两个供应商下，也不能在同一供应商内重复。
3. 每个供应商至少有一个域名，并且恰好有一个主域名。
4. 匹配采用完整 hostname 精确匹配；不使用 `endsWith`，也不自动匹配子域名。
5. 输入 `base_url` 的 hostname 应先转为小写、移除末尾的点，并按 IDNA 转为 ASCII。

运行时可以从该文件构建反向索引：

```text
api.relay-example.com     -> relay-example
gateway.relay-example.net -> relay-example
api.another-relay.example -> another-relay
```

数据库侧建议使用独立的 `provider_domains` 表，并将规范化 hostname 设为主键、`provider_slug` 设为外键。这样可以由数据库直接保证“一个域名只能属于一个供应商”。
