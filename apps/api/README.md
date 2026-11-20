# API

Node.js/TypeScript API. The foundation exposes `GET /health/live` for process
liveness and returns a JSON 404 for unimplemented routes. It does not connect to
the databases or implement academic workflows yet.

Run `npm run dev:api` from the repository root. Keep server startup in
`src/server.ts` and application composition in `src/app.ts` so HTTP behaviour can
be exercised without running a persistent development server.

Administrative PostgreSQL migration/seed/demo commands live in `scripts/db/` and
are exposed from the root package. They are not HTTP endpoints or an authenticated
writer API. See the [database guide](../../db/README.md).
