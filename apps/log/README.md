# Signed workflow history operator

This separate operator publishes signed checkpoints, exports private event proofs
and audits workflow history through restricted SQL/Mongo identities. The API and
worker never receive signing keys or salts. API `202` still means SQL acceptance,
not signed publication or completed MongoDB delivery.

## Run

After normal database/API/worker setup, from the repository root:

```powershell
npm run db:migrate
npm run log:setup
npm run build
npm run log:demo
```

The demo signs existing synthetic history, runs an independently approved HTTP
correction, signs its extension and invokes the compiled offline verifier. It
tests changed payload/path/signature, rollback and conflicting signed roots in
memory, then audits actual SQL/Mongo data. Each complete run grows synthetic
history. Only summary results, public checkpoints and private-export paths print.

```powershell
$logId = (Get-Content .runtime/workflow-fixture.json -Raw | ConvertFrom-Json).institutionId
npm run log:publish -- --log-id $logId
npm run log:audit -- --log-id $logId
npm run log:export -- --log-id $logId --event-id <expected-event-uuid> --out .runtime/private-proof.json
npm run verify:event -- --bundle .runtime/private-proof.json --public-key .runtime/log-keys/public.pem --log-id $logId --event-id <expected-event-uuid>
```

The offline verifier requires no database/server. Pin its public key and expected
log/event identity separately from the untrusted proof. Export with
`--previous .runtime/retained-before.json` and pass that same independently retained
checkpoint to the verifier's `--previous` option to check extension consistency.
Input files use canonical UTF-8 JSON, not pretty-printed JSON.

## State and recovery

- `.env.log` contains separate generated service passwords. Setup authenticates
  both restricted identities and preserves existing passwords. If the file is
  lost, restore matching credentials; existing users are not silently reset.
- `.runtime/log-keys/private.pem` holds the Ed25519 key; `public.pem` is the
  pinned development public key. Setup preserves the pair and refuses partial or
  mismatched files. Git is not a secret store.
- `.runtime/log-observations/<log-id>.json` retains an accepted checkpoint outside
  SQL/MongoDB. Its prefix is checked before signing. Existing SQL checkpoints
  without this retained observation cause a closed failure; restore trusted state
  rather than accepting an arbitrary replacement baseline.
- Publication holds a local observation lock. It retains/returns a checkpoint
  only after SQL commit and reuses the exact persisted evidence on retry. A stale
  `.lock` requires checking that its process stopped and reviewing retained/SQL
  state before removing only that lock.
- Private proof exports refuse overwrites and stay under ignored `.runtime/`.
  A recipient receives the selected complete event and salt. This is not a public
  log dump or a Week 6 selective-disclosure credential.

The same-host observation store demonstrates a protocol, not independent witness
control. A database rollback experiment must retain later observations outside
the restored state. An administrator who can rewrite every key and observation
remains outside that protection.

## Coverage and limits

The audit recomputes event commitments, compares immutable SQL grade/request/
decision facts, checks heads structurally, rehashes raw evidence bytes and checks
Mongo receipt/revision/head data. Invalid integrity, pending delivery and
unavailable observations remain distinct. Mongo ahead of a SQL snapshot requires
another observation instead of a corruption verdict.

Coverage reports identify seed/admin grade versions without workflow events.
Academic catalogue metadata and the SQL temporal cache are outside cryptographic
coverage. Signatures do not establish factual grade correctness; historical
validity does not prove currentness. Credential status/freshness/challenge binding
belong to Week 6.

The first `bootstrapSize` leaves import existing events by `(occurred_at,event_id)`;
their original commit order is unknown. Later appends are transactionally ordered
per institution, not globally. In-memory publication/audit is bounded to 100,000
events per log; larger histories need streaming support.

See [architecture](../../docs/architecture/transparency-log.md) and the
[verifier profile](../../packages/verification/README.md).
