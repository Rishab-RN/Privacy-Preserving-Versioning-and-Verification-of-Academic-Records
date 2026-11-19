# Database source

PostgreSQL will own structured academic state; MongoDB will hold flexible evidence
and document packages. No schema has been implemented pending the owner's reviewed
ER/DFD diagrams.

- `migrations/`: ordered, reviewed schema changes; commit migration source.
- `seeds/`: deterministic synthetic fixtures; no real student records.

Local service data and backups belong in ignored runtime locations or Docker
volumes, never in these source directories.
