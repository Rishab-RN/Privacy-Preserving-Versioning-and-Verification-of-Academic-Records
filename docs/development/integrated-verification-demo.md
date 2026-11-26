# Integrated verification and recovery demo

Use the synthetic institution. A registrar or auditor can inspect a correction's
signed event, retained checkpoint, Neo4j approval trail and advisory anomaly score
from the same workspace.

## Prepare the witness

Apply migrations through `0015`, provision the log signer, and prepare the graph
and model through the [provenance](provenance-demo.md) and [anomaly](anomaly-demo.md)
guides. Keep one accepted checkpoint outside the databases being tested.

```powershell
$fixture = Get-Content .runtime/workflow-fixture.json -Raw | ConvertFrom-Json
$logId = $fixture.institutionId
$key = '.runtime/log-keys/public.pem'
$prior = Join-Path '.runtime/log-witness' "$logId.json"
$transfer = ".runtime/log-demo/witness-$([guid]::NewGuid()).json"
$previous = @()
if (Test-Path -LiteralPath $prior) { $previous = @('--previous', $prior) }

npm run log:publish -- --log-id $logId
npm run log:link -- --log-id $logId --out $transfer @previous
npm run log:witness -- observe --log-id $logId --public-key $key --incoming $transfer
```

The first observation requires a trusted initial checkpoint. Later transfers
include a proof from the witness's retained checkpoint. A successful extension
advances the retained file. `check` compares without advancing it. Repeating the
same checkpoint with an empty consistency path is an exact retry. The command
returns 0 for success, 1 for a rejected observation, and 2 when its input files
or storage cannot be used. A rejected observation leaves the retained file intact.

For a separately operated witness, copy the transfer and the independently
pinned **public** key to that host. Run the same command with
`--state-dir <witness-storage>`. Return a copy of the retained checkpoint to the
signer as the input for the next consistency proof. For the web check, set
`LOG_WITNESS_DIRECTORY` to an absolute path containing the reviewer-controlled
copies and give the API read-only filesystem access. Its default uses the lab
witness directory. The signer and the witness have separate file stores
in the lab, which still share control of the same host.

## Review one approved correction

1. In **Review**, look up an independently approved correction. Copy **Approval
   event** from the **Correction integrity** panel. This is the event ID used by
   the export command.
2. Publish a checkpoint that covers the chosen event. Export the original
   canonical JSON. The extra consistency proof below links to the last accepted
   witness checkpoint while the witness file remains at that observation.

```powershell
$eventId = '<approval-event-uuid>'
$proof = ".runtime/log-demo/approval-$([guid]::NewGuid()).json"
npm run log:publish -- --log-id $logId
npm run log:export -- --log-id $logId --event-id $eventId --previous $prior --out $proof
```

3. Select **View version provenance**, **Load provenance**, then upload the
   approval export. **Correction integrity** reports the signed event match and
   witness comparison. **Projection freshness** shows Neo4j coverage.
   **Anomaly review** shows the selected correction's score when the model
   snapshot is current.
4. After a new synthetic approval, publish and export again while the graph
   worker is stopped. The signed proof can pass while Neo4j and scores lag.
   Sync the graph and republish the model using the [anomaly demo](anomaly-demo.md).
5. Use the public verifier for the student's private grade proof and review
   its signed issuance and live status separately. An accepted historical
   correction does not establish a credential's present status.
   [Zero-knowledge demo](zero-knowledge-demo.md)

The approval export is private and contains an event opening. Keep it in
`.runtime` and share it only with an authorised reviewer. The integrity route
returns verdicts and position counts. It does not return the raw opening.

## Controlled failure and recovery checks

Use the automated checks for fault injection. The integration harness allocates
temporary SQL and MongoDB databases and a random Neo4j scope.

| Check                                                  | Expected outcome                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Smaller signed candidate presented as the current head | Witness reports rollback and retains its later observation                         |
| Same-size signed roots disagree                        | Witness reports conflict and preserves the retained bytes                          |
| Altered inclusion path, wrong event or wrong signature | Integrity fails even when the anomaly panel shows a low score                      |
| Journal shorter than the retained observation          | Reviewer sees SQL journal behind the witness                                       |
| Missing, altered or reordered committed event          | Scoped verification or full audit rejects the evidence                             |
| Graph unavailable, lagging or rebuilt                  | Provenance reports its state. Anomaly scores require a matching fresh snapshot     |
| Worker interrupted during MongoDB projection delivery  | Retry uses the committed event. A receipt-only write can resume after lease expiry |
| Valid historical issuance after credential revocation  | Historical proof may pass. The live verifier rejects the revoked credential        |

```powershell
node --import tsx --test apps/log/test/witness.test.ts
npm run test:integration
$env:ANOMALY_PYTHON = (Resolve-Path '.venv/Scripts/python.exe').Path
npm run test:web
```

The integrated browser test expects a published Week 9 model snapshot. The
isolated suite also runs the full SQL/MongoDB reconstruction audit. On a lab
institution, run `npm run log:audit -- --log-id $logId` for evidence documents,
projection receipts and coverage beyond the single-event portal check.

The selected-event check independently reconstructs the SQL event and compares
its canonical facts, salt and committed position. A scope check precedes that
read. The witness tests append-only consistency using a pinned signer and a
retained observation. The first accepted view and the signer clock are trust
inputs. A historical artifact may predate the witness without proving that the
current journal rolled back. Conflicts are detectable only when a retained
observation and the conflicting view are compared. [RFC 9162, Merkle consistency proofs](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1.4)
