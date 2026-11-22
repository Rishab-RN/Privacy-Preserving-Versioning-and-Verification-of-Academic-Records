# Database source

PostgreSQL owns structured academic state. The Week 2 implementation contains
thirteen academic tables, immutable revisions and a derived bitemporal projection.
The [model and assumptions](../docs/architecture/academic-model.md) are provisional
pending owner-supplied diagrams and grading-policy review. MongoDB is reserved for
flexible evidence/document packages; it is not a competing transcript authority.

Week 3 adds migrations `0004`/`0005`: password/session tables, immutable scoped
evidence references and restricted API permissions. The old read-only group is
hardened against unsafe inherited grants. See the
[access/evidence design](../docs/architecture/access-and-evidence.md) and
[Mongo validator guide](mongo/README.md).

- `migrations/`: ordered, reviewed schema changes; commit migration source.
- `seeds/`: deterministic synthetic fixtures; no real student records.
- `queries/`: parameterized transcript SQL for demonstrations and plan inspection.

## Local commands

After `npm ci`, `npm run setup` and `npm run infra:up`, run from the root:

```powershell
npm run db:status
npm run db:migrate
npm run db:seed
npm run db:demo
npm run db:plan
npm run test:db
```

The tools read the root `.env` without printing credentials and connect only to
the local PostgreSQL port. Use a dedicated database; migration/seed commands
reject maintenance database names. No automatic migration runs on API startup.

`db:migrate` takes a database advisory lock and applies each pending file in its
own transaction. `scholarproof_meta.schema_migrations` records normalized SHA-256
checksums. Repeating the command is safe; changed, removed or reordered applied
files are rejected. SQL files must not include their own transaction commands.
See [migration conventions](migrations/README.md).

`db:seed` transactionally loads one synthetic university, 25 students, four
offerings, 100 grade records and 102 grade versions. The seed marker makes repeat
runs a no-op. Identifier collisions fail and roll back instead of overwriting
existing data. See [fixture details](seeds/README.md).

`db:demo` compares the first synthetic student's course result before and after
correction using the recorded timestamps stored in the database. `db:plan` also
uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the direct read-only query and
saves `.runtime/transcript-query-plan.json`. The 100-record fixture is for query
inspection, not a performance or scalability claim.

## Privileges and test isolation

The local administrative account needs schema/table creation, `btree_gist`
installation and role creation privileges. `test:db` also needs `CREATE DATABASE`
on the local cluster. These are development/migration credentials, not an
authenticated application role. `access:setup` provisions the separate API login;
the [API authorization policy](../docs/architecture/access-and-evidence.md) defines
its application-level scope.

`scholarproof_runtime` is a non-owner, read-only NOLOGIN group. Tests switch into
it to prove reads succeed and academic writes/DDL fail. It is cluster-scoped and
is retained when a test database is removed. The runner reuses a compatible role
and never drops it; it rejects conflicting role flags. Read grants currently cover
the prototype's entire academic schema, without per-student RLS.

`test:db` creates a uniquely named `scholarproof_test_<uuid>` database, runs two
fresh migration clients concurrently, executes real PostgreSQL integration tests,
and drops only the database created by that run. It does not reset development
tables or delete Docker volumes. An interrupted process can leave its temporary
database behind; inspect it before any manual cleanup.

The normal `npm run check` includes database-tooling unit checks without requiring
PostgreSQL. Live database checks are deliberately explicit through `test:db`.
GitHub CI defines a separate PostgreSQL 18 integration job using an ephemeral
service, following the [GitHub service-container guide](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers).

`npm run test:integration` additionally provisions a unique Mongo database and
restricted temporary SQL/Mongo API identities to exercise real HTTP flows and
storage faults. Run it after `test:db`, not concurrently: SQL permission-rejection
tests temporarily modify cluster-scoped group grants inside rolled-back transactions.
The CI data job includes PostgreSQL 18 and MongoDB 8 services and runs both commands.

Run `npm run access:setup` after migrations to create preserved local runtime
credentials in `.env.api`. The API does not use the migration administrator.

## Recovery and changes

If a migration fails, its own transaction rolls back while earlier successful
migrations remain applied. Inspect `db:status`, resolve the cause and retry. Keep
applied files immutable; add a new numbered forward migration for later changes.
For an unapplied failing file, review the fix before retrying it. There is no
automatic down/reset command. Back up valuable data and plan any destructive
change separately; normal `infra:down` preserves Docker volumes.

Local service data and backups belong in ignored runtime locations or Docker
volumes, never in these source directories.
