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
npm run check
npm run build
```

`npm ci` uses the committed root lockfile. Keep one package manager and one root
lockfile for this workspace. When intentionally changing dependencies, use npm and
include the resulting manifest and lockfile changes together.

`npm run check` runs lint, formatting verification, type checking and tests. The
scripts are declared in `package.json`; a passing tooling check is not evidence
that academic issuance, cryptographic verification or database recovery has been
implemented.

An ignored `.env` with generated local database passwords has been created on the
current development machine. Preserve it. On a fresh checkout, copy the safe
example once without overwriting an existing environment file:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Before first database initialization, replace the example database passwords with
fresh local values. The API can start with its defaults; it loads the root `.env`
when present. Keep real values in that ignored file and document supported options
in `.env.example`.

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

`infra:check` uses the configured client credentials for a PostgreSQL `SELECT 1`
and a MongoDB ping. It checks actual service access separately from Compose
configuration validation and container status.

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

Current work is Week 1 dependency/environment setup. React, React DOM, Vite and
Tailwind are installed and the Vite configuration is type checked; there is no
runnable UI entry yet. Frontend product flows, background publication jobs,
database migrations and independent credential verification follow in later agreed
weekly stages. ER/DFD diagrams will be supplied by the project owner before schema
implementation. Do not treat installed packages or reserved folders as completed
features.

For ownership and dependency boundaries, see
[Repository layout](repository-layout.md). For branches and manual commits, see
[Git workflow](git-workflow.md).
