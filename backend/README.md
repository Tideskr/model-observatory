# Model Observatory Backend

Node.js 22 + TypeScript control plane for the Model Observatory. The public API is mounted at `/api/v1`; local OpenAPI documentation is available at `/api/docs` by default.

## Local development

```bash
npm install
npm run dev
```

The default `DATABASE_URL=memory:` mode is for tests and local UI/API development. It is process-local and deliberately starts with an empty public read model. Production uses the migrations in `migrations/` and a PostgreSQL worker queue.

Use `.env.example` as the environment-variable checklist and replace every secret before using any endpoint that accepts credentials. The process does not implicitly load `.env`; export the values through the shell or service manager. Development fallbacks are generated in memory on every process start and cannot decrypt data after a restart.

## PostgreSQL setup

Set `DATABASE_URL`, then run the schema and import the normalized Legacy scoring release:

```bash
npm run db:migrate
npm run scoring:import
npm run dev
```

Run the executor separately:

```bash
npm run worker
```

The importer validates both Legacy JSON documents, all pinned prompt hashes, the cross-file release identity, and the baseline content hash before inserting 11 probes, 15 templates, 27 signatures, 12 fitted cells, 4 calibrations, and 6 ordered verdict rules.

## Security boundary

- Remote execution initially supports Normal requests only. Native requests remain local until isolated ephemeral executors are audited.
- Credentials must never enter normal run rows, queue payloads, logs, traces, or error bodies.
- API donations begin in quarantine. Business rows contain only an encrypted-envelope handle, a short HMAC fingerprint tail, and a hashed revocation capability.
- Public conclusions use the three frontend evidence sources: `community`, `donated`, and `vendor`. Vendor samples remain excluded from the headline.
- `Legacy/` is an audit and migration source. Backend code must not import or execute Legacy modules at runtime.
