# Synthetic seed data

`npm run db:seed` runs `0001_demo.sql` after all migrations are applied. It creates
25 synthetic students, four course offerings, 100 enrolments/grade records and
102 versions. Student 1/course 1 changes from 4/failed to 8/passed. Student 2/course
2 has a partial valid-time correction during April-June 2026.

Identifiers and grade values are deterministic; recorded timestamps come from
PostgreSQL at insertion time. MD5-derived UUIDs are convenient fixture labels,
not privacy-preserving commitments. No real student information is included.

The runner takes a transaction-level lock and stores a checksum marker. A repeated
run does nothing; changed applied source is rejected. A collision or failed insert
rolls back the fixture instead of overwriting existing rows. Future datasets should
have their own versioned seed source and explicit runner support.
