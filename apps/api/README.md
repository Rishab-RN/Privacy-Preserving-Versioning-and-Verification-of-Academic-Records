# API

Node.js/TypeScript API. The foundation exposes `GET /health/live` for process
liveness and returns a JSON 404 for unimplemented routes. Week 3 adds authenticated
scoped transcript reads and bounded Mongo evidence under `/api/v1`. Grade issue,
correction and approval routes are not implemented.

Run `npm run dev:api` from the repository root. Keep server startup in
`src/server.ts` and application composition in `src/app.ts` so HTTP behaviour can
be exercised without running a persistent development server.

Administrative PostgreSQL migration/seed/demo commands live in `scripts/db/` and
are exposed from the root package. They are not HTTP endpoints or an authenticated
writer API. See the [database guide](../../db/README.md).

Run `npm run access:setup` and `npm run access:demo` before the data API walkthrough.
Runtime credentials are loaded from ignored `.env.api`, separately from migration
credentials. Read the [API guide](../../docs/development/api.md) and
[security/evidence design](../../docs/architecture/access-and-evidence.md).
