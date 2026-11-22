# Dependencies and phase boundaries

Use one npm workspace, one root `package-lock.json`, and `npm ci` for repeatable
installs. All application packages are private; `UNLICENSED` in the root manifest
does not select an open-source licence. The owner still needs to choose reuse terms.

## Week 1 foundation

| Area           | Installed or configured                      | Current use                                               |
| -------------- | -------------------------------------------- | --------------------------------------------------------- |
| Runtime        | Node.js 24, npm 11                           | API and repository commands                               |
| TypeScript     | TypeScript 6.0, TSX, Node types              | Strict compiler and development runner                    |
| Quality        | ESLint 10, typescript-eslint 8, Prettier 3   | Shared lint/format checks                                 |
| API            | Express 5, Zod 4                             | HTTP foundation; Zod reserved for domain input validation |
| SQL            | `pg` and its types                           | Migration/seed CLI and PostgreSQL integration checks      |
| Documents      | MongoDB Node driver                          | Installed; document operations not yet implemented        |
| Frontend       | React 19, Vite 8, Tailwind 4 and types       | Installed/type-checked configuration; UI pending          |
| Local services | Docker Compose, PostgreSQL 18, MongoDB 8.0   | Optional development containers                           |
| Test runner    | Node's test runner; TSX for TypeScript cases | Tooling/HTTP checks and isolated PostgreSQL tests         |

Versions are exact in manifests and resolved by the lockfile. TypeScript 7 was the
registry default at setup time, but the selected typescript-eslint release declares
support below TypeScript 6.1; TypeScript 6.0.3 was chosen to keep the tooling within
its declared compatibility range. Change this choice through a tested dependency
update rather than bypassing peer checks.

The root `build` compiles the implemented API/contracts. It does not pretend to
build frontend pages, a worker or a verifier before those exist. `typecheck` also
checks the installed frontend configuration.

Week 2 uses the existing `pg` client and Node tooling for migrations and fixtures;
no new npm dependency was added. PostgreSQL's `btree_gist` extension supports the
temporal exclusion constraint. The model and current permission boundary are
documented in the [academic model](../architecture/academic-model.md).

Week 3 also uses existing dependencies: Node crypto for scrypt/random session
tokens/SHA-256, Zod for HTTP contracts, and the Mongo driver for validated evidence.
No new npm package or external identity server is required. This local identity
adapter does not establish institutional SSO integration.

## Introduce dependencies with their implementation stage

| Stage                         | Add when needed                                   | Decision gate                                                                                         |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Schema and API                | Migration/auth/session tooling                    | Reviewed model and authentication design                                                              |
| Credential issuance           | Maintained SD-JWT implementation                  | Pin exact profile and test interoperability                                                           |
| Required graph provenance     | Neo4j driver/server                               | Week 8: scoped provenance schema, mandatory Cypher queries, SQL comparison and recoverable projection |
| Required ML anomaly detection | Python environment, scikit-learn and data tooling | Week 9: reproducible generator, rules/model baselines, graph features and leakage-safe evaluation     |
| Use-case ZK decision          | Circom/snarkjs and circuit dependencies           | Reviewed bounded statement, manifest completeness and setup assumptions                               |
| Use-case vector decision      | pgvector or a dedicated engine                    | A defined use case that justifies the extra infrastructure                                            |

These later tools are not required to run Week 1 and are not yet installed by this
repository. Neo4j and Python ML are mandatory in their scheduled stages; installation
timing does not make them optional. Pin supported versions and verify real
connectivity/imports when those stages begin. Use an isolated, ignored Python
environment and a locked requirement set rather than a global ML installation.
Python 3.12 is available on the current developer machine. ZK/vector dependencies
remain separate use-case decisions and cannot displace the mandatory components.

The [required capability contract](../architecture/required-capabilities.md)
defines meaningful Neo4j and ML use cases and the evidence required for completion.

## Source documentation checked during setup

- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/)
- [Express installation](https://expressjs.com/en/starter/installing/)
- [typescript-eslint setup](https://typescript-eslint.io/getting-started/)
- [Vite guide](https://vite.dev/guide/)
- [Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite)
- [PostgreSQL image storage layout](https://github.com/docker-library/docs/blob/master/postgres/README.md)

Container release-line tags are appropriate for local setup. Record immutable image
digests, machine details and workload seeds when producing reproducible research
measurements.
