# Integration tests

`database/` contains real PostgreSQL checks for tenant foreign keys, grade policy,
immutable relationships, temporal corrections, competing writers, runtime grants,
migration drift/rollback and fixture idempotency. Run them with `npm run test:db`;
the harness creates and removes an isolated database. See the
[database guide](../db/README.md) for required privileges.

Package-level API/tooling tests live in `apps/api/test/` and `scripts/test/` and run
with `npm test`. Publication recovery, academic write workflows and independent
verification tests will be introduced with those implementations.

`integration/` exercises real HTTP authentication, SQL tenant/subject reads and
Mongo evidence validation/permissions, including digest faults and interrupted
writes. `npm run test:integration` provisions isolated SQL/Mongo databases and
restricted runtime identities. It requires the administrative local services;
it never uses the development API process or its credentials.
