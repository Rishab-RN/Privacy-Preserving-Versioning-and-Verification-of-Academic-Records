# Local development

## Requirements

- Node.js 24 and npm 11 for the initial workspace setup.
- Git.
- Docker with Compose when using the local PostgreSQL/MongoDB services.

Use the versions declared in the root `package.json` and committed tooling files as
the repository's source of truth. Database services are optional for work on code
that does not yet use them.

## Install and check

From the repository root:

```powershell
npm ci
npm run setup
npm run doctor
npm run check
npm run build
```

`npm ci` uses the committed root lockfile. Keep one package manager and one root
lockfile for this workspace. When intentionally changing dependencies, use npm and
include the resulting manifest and lockfile changes together.

`npm run setup` creates the root `.env` from `.env.example` only when it does not
already exist, replacing the example database passwords with generated local
values. It does not print those secrets or overwrite an existing configuration.
Preserve the existing `.env` when reusing initialized database volumes; running
setup again is not a password-rotation operation.

`npm run doctor` reports runtime/tool prerequisites and local configuration
presence without exposing secret values. Docker is optional for API-only work.
Before database work, require the Docker prerequisite explicitly:

```powershell
npm run doctor -- --require-docker
```

Doctor does not install missing tools, start containers or prove that database
credentials work. Resolve any reported prerequisite problem, then use the live
service checks below. Keep supported environment options in `.env.example` and
real values in the ignored `.env`.

`npm run check` runs lint, formatting verification, type checking and tests. The
scripts are declared in `package.json`; a passing tooling check is not evidence
that academic issuance, cryptographic verification or database recovery has been
implemented. The API can start with its defaults and loads the root `.env` when
present.

## API development

```powershell
npm run dev:api
```

The default address is `http://127.0.0.1:4000`, configured by `API_HOST` and
`API_PORT`. In a second terminal, check process liveness:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/health/live
```

This endpoint checks the running API process. It does not establish database
connectivity, authentication or academic workflow readiness. The API does not yet
issue academic records or implement corrections or credential verification.

To run the compiled API after a successful build:

```powershell
npm run start:api
```

Use either development or compiled startup on a given port, not both at once.

Run long-lived development commands in their own terminal and use `Ctrl+C` to stop
them. Report startup failures with the relevant redacted error and configuration;
do not disable validation to make the process start.

## Local databases

When working on database integration:

```powershell
npm run infra:config
npm run doctor -- --require-docker
npm run infra:up
npm run infra:status
npm run infra:check
```

Stop the local services with:

```powershell
npm run infra:down
```

The Compose definition is `infra/docker/compose.yaml`. It provides PostgreSQL 18
and MongoDB 8.0 on local host ports `55432` and `57017` respectively. Use only
synthetic data. `infra:config` validates the example configuration; it does not
prove that Docker's engine is available or that either database has started.
`infra:up` waits up to 120 seconds for the containers' health checks rather than
reporting readiness immediately after starting them.

`infra:check` uses the configured client credentials for a PostgreSQL `SELECT 1`
and a MongoDB ping. It reports each service separately so a PostgreSQL failure
does not hide MongoDB's result, or vice versa. Diagnostics use safe failure codes
without printing passwords or connection strings. A failed live check remains a
failure even if the container is marked healthy.

If Docker access fails, start Docker Desktop and resolve the reported engine or
permission issue. If a live check fails, inspect that service's status and the
local configuration without pasting secrets into an issue. Existing volumes may
still contain the credentials used at their first initialization.

The API request handlers are not integrated with these databases yet. Local
service readiness does not establish an approved academic schema or implemented
academic workflow. Normal shutdown preserves database volumes; volume deletion is
a separate deliberate reset operation. Keep `.env` aligned with the existing
volume credentials: changing an environment password does not rotate users inside
an already initialized database volume.

Keep real connection strings and credentials in ignored local configuration. Use
the committed example configuration as a template rather than committing your
local environment file. Review the Compose configuration before exposing services
outside your development machine.

## Current implementation boundary

Week 1 setup is verified. Week 2 adds explicit SQL migrations, synthetic fixtures,
immutable grade revisions and known-at/effective-at transcript queries. Run:

```powershell
npm run db:migrate
npm run db:seed
npm run db:demo
npm run test:db
```

See the [database guide](../../db/README.md) for permissions, query plans and
recovery. The SQL model is provisional pending owner diagrams and grading rules.
`npm run check` does not run live database tests; use `npm run test:db` explicitly.

React, React DOM, Vite and Tailwind are installed and the Vite configuration is
type checked; there is no runnable UI entry yet. Authenticated domain APIs,
MongoDB document operations, frontend flows, background jobs and credential
verification remain later weekly stages.

For ownership and dependency boundaries, see
[Repository layout](repository-layout.md). For branches and manual commits, see
[Git workflow](git-workflow.md).
