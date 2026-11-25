# Dependencies and phase boundaries

Use one npm workspace, one root `package-lock.json`, and `npm ci` for repeatable
installs. All application packages are private; `UNLICENSED` in the root manifest
does not select an open-source licence. The owner still needs to choose reuse terms.

## Week 1 foundation

| Area           | Installed or configured                      | Current use                                                |
| -------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Runtime        | Node.js 24, npm 11                           | API and repository commands                                |
| TypeScript     | TypeScript 6.0, TSX, Node types              | Strict compiler and development runner                     |
| Quality        | ESLint 10, typescript-eslint 8, Prettier 3   | Shared lint/format checks                                  |
| API            | Express 5, Zod 4                             | Scoped HTTP routes and strict domain input validation      |
| SQL            | `pg` and its types                           | Migrations, temporal queries, approval wrappers and outbox |
| Documents      | MongoDB Node driver                          | Validated evidence and recoverable workflow projections    |
| Frontend       | React 19, Vite 8, Tailwind 4 and types       | Live scoped workspace, forms and review screens            |
| Local services | Docker Compose, PostgreSQL 18, MongoDB 8.0   | Optional development containers                            |
| Test runner    | Node's test runner; TSX for TypeScript cases | Tooling/HTTP checks and isolated PostgreSQL tests          |

Versions are exact in manifests and resolved by the lockfile. TypeScript 7 was the
registry default at setup time, but the selected typescript-eslint release declares
support below TypeScript 6.1; TypeScript 6.0.3 was chosen to keep the tooling within
its declared compatibility range. Change this choice through a tested dependency
update rather than bypassing peer checks.

The root `build` compiles the API, contracts, worker, independent verifier and log
operator. `typecheck` also checks scripts, tests and the installed frontend
configuration. It now builds the frontend production bundle as well. Playwright
`1.65.1` checks the live browser flow against synthetic API fixtures; local runs
can use an installed Chrome executable, while CI installs Chromium.

Week 2 uses the existing `pg` client and Node tooling for migrations and fixtures;
no new npm dependency was added. PostgreSQL's `btree_gist` extension supports the
temporal exclusion constraint. The model and current permission boundary are
documented in the [academic model](../architecture/academic-model.md).

Week 3 also uses existing dependencies: Node crypto for scrypt/random session
tokens/SHA-256, Zod for HTTP contracts, and the Mongo driver for validated evidence.
No new npm package or external identity server is required. This local identity
adapter does not establish institutional SSO integration.

Week 4 reuses the same pinned `pg`, MongoDB and Zod versions in a separate worker
workspace; it adds no external dependency family or queue service. PostgreSQL owns
atomic approval, the retained journal and leased outbox. MongoDB stores rebuildable
receipts/revisions and a latest-recorded-version pointer. Provisioning runs with
administrative local credentials; API and worker runtime identities remain separate
and restricted. See the [workflow contract](../architecture/record-workflow.md) and
[worker guide](../../apps/worker/README.md) for failure and replay limits.

The BCNF storage follow-up also uses existing dependencies. Forward migrations
`0008`/`0009` decompose the physical relations, rebuild controlled SQL interfaces and
provide computed context views. The normalized seed is `0002_bcnf_demo.sql`; its
runner preserves and verifies the original `0001_demo.sql` checksum when carrying
forward an existing fixture. It never rewrites historical migrations, rotates
credentials or resets academic history to satisfy a report.

Week 5 adds two local workspaces and no new external npm dependency. The verifier
uses bounded RFC 8785 JSON serialization, SHA-256 and native Node Ed25519; its
RFC 9162 Merkle tree/proof algorithms are checked with independent vectors. This
is an application checkpoint profile, not Certificate Transparency wire-format
interoperability. The log operator reuses pinned `pg`/MongoDB drivers. PostgreSQL
`pgcrypto` supplies private random salts; keys and observations stay outside SQL.
See the [operator guide](../../apps/log/README.md) for setup and trust boundaries.

## Introduce dependencies with their implementation stage

Week 6 adds `packages/credentials` and pins `jose@6.2.18` for JOSE signing and
verification. Flat RFC 9901 disclosure/consent semantics live in the application
profile, with a published hash fixture and independent Node Ed25519 JWT fixtures.
The root build, types and tests include this package. This SD-JWT library remains
stateless; see the
[profile](../architecture/credential-profile.md) for its explicit limits.

The mandatory ZK slice adds `packages/zk`: pinned `snarkjs@0.7.6`,
`circomlibjs@0.1.7`, `circomlib@2.0.5`, official hash-pinned native Circom 2.2.3 and
`poseidon-lite@0.3.0` for the browser's holder commitment. Node uses circomlibjs;
the browser's small helper matches the real circuit but is unaudited and uses
non-constant-time BigInt. Browser-local proving runs in a worker with artifact
hash checks. `npm run zk:setup` generates and preserves ignored development
ceremony artifacts and a separate issuer key pair; `test:zk` requires that setup.
SQL migration `0012` and the connected HTTP/UI flow implement the separate ZK
profile's persistence, status and one-use challenge gate. See the
[setup/demo guide](zero-knowledge-demo.md) and [trust limits](../architecture/zero-knowledge-proofs.md).

Overrides pin `underscore@1.13.8` and `ws@8.21.0` to resolve the affected transitive
versions. The installation audit at this milestone has no high/moderate advisories;
15 low advisories remain through circomlibjs's unused ethers/elliptic signing
dependency chain. The project uses neither those wallet signing helpers nor their
private-key generation. This is a residual dependency risk, not a zero-vulnerability
claim; do not apply a breaking `npm audit fix --force` downgrade as a remedy.

| Stage                         | Add when needed                                    | Decision gate                                                                                         |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Schema and API                | Migration/auth/session tooling                     | Reviewed model and authentication design                                                              |
| Credential issuance           | Maintained SD-JWT implementation                   | Pin exact profile and test interoperability                                                           |
| Required graph provenance     | Neo4j driver/server                                | Week 8: scoped provenance schema, mandatory Cypher queries, SQL comparison and recoverable projection |
| Required ML anomaly detection | Python environment, scikit-learn and data tooling  | Week 9: reproducible generator, rules/model baselines, graph features and leakage-safe evaluation     |
| Mandatory ZK predicate        | Circom/snarkjs and circuit dependencies, installed | Exact approved-grade statement, complete artifact manifest and explicit development setup trust       |
| Use-case vector decision      | pgvector or a dedicated engine                     | A defined use case that justifies the extra infrastructure                                            |

Neo4j and Python ML are not required to run Week 1 and are not yet installed by this
repository. They are mandatory in their scheduled stages; installation
timing does not make them optional. Pin supported versions and verify real
connectivity/imports when those stages begin. Use an isolated, ignored Python
environment and a locked requirement set rather than a global ML installation.
Python 3.12 is available on the current developer machine. ZK is now mandatory;
vector search remains a separate use-case decision. Neither displaces graph/ML.

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
