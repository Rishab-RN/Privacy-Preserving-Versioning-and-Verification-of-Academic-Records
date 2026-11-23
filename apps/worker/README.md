# Background worker

Consumes the committed PostgreSQL outbox and builds MongoDB workflow receipts,
immutable grade revisions and a monotonic latest-recorded-version pointer.
PostgreSQL remains the academic authority. These collections do not replace the
effective-time transcript or constitute signed credentials.

From the repository root, after migrations and database seeding:

```powershell
npm run worker:setup
npm run worker:once
npm run dev:worker
npm run worker:replay
```

`worker:setup` uses administrative development credentials to provision a separate
restricted identity and strict collection validators. It creates ignored
`.env.worker` only when absent, preserves existing passwords and rejects unsafe
permission drift. Runtime uses only this worker identity: queue functions and
journal reads in PostgreSQL; insert/read receipts and revisions, and update/read
heads in MongoDB. It cannot read API credentials or write academic tables.

Each batch claims up to five deliveries with 60-second leases. Acknowledgement
follows successful projection. Interrupted or expired claims can be retried;
duplicates must match their stored content. Conflicting content is preserved and
reported, never overwritten. SQL tracks failures separately from claim attempts,
backs off retries and quarantines after eight failures. SIGINT/SIGTERM finishes
the current delivery; unprocessed claims become available after lease expiry.

`worker:once` processes one batch. `worker:replay` reads one committed journal
snapshot, up to 10,000 events, and resumes/rebuilds derived documents without
deleting collections or acknowledging live delivery leases. Provisioning must
precede replay if an operator has removed a collection. Replay does not repair
conflicting documents or reset quarantined deliveries. Those require an explicit
operator investigation; no repair/reset command is provided yet.

Revision ordering uses each record's version number, so delayed events cannot
regress its pointer. There is no cross-record commit-order guarantee. Sorted JSON
fingerprints detect conflicting projection contents; they are not signatures or
proofs against a privileged database administrator. Neo4j, cryptographic witnesses
and ML consumers remain later required milestones.
