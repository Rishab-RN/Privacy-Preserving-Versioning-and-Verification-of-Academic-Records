# Integration tests

`database/` contains real PostgreSQL checks for tenant foreign keys, grade policy,
immutable relationships, temporal corrections, competing writers, runtime grants,
migration drift/rollback and fixture idempotency. Run them with `npm run test:db`;
the harness creates and removes an isolated database. See the
[database guide](../db/README.md) for required privileges.

Package-level API/tooling tests live in `apps/api/test/` and `scripts/test/` and run
with `npm test`. Publication recovery, HTTP academic workflows and independent
verification tests will be introduced with those implementations.
