# Migrations

Run `npm run db:migrate` from the repository root. Files use contiguous four-digit
versions: `0001_academic_core.sql`, `0002_temporal_grades.sql`, and so on. Each
file is executed transactionally by the runner. Do not put `BEGIN`, `COMMIT` or
nontransactional operations in these files.

Applied filenames/checksums must remain unchanged. Checksums normalize CRLF to LF
so Windows and Linux checkouts agree. Add forward migrations for new changes;
never repair an applied migration by editing its checksum in the database. Source
checksums identify drift; a database owner can still alter metadata and tables.

The initial model is provisional; owner diagrams and institutional grading rules
still need review. Document constraints, rollout and recovery implications with
each change. See the [database guide](../README.md).
