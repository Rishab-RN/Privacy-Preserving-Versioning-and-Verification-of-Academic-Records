# API development guide

The API binds to `127.0.0.1:4000` by default. All `/api/v1` responses use
`Cache-Control: no-store`; errors are JSON `{error:{code,message}}` without raw
database exceptions or credentials. Public liveness remains `/health/live`.

## Prepare locally

```powershell
npm run infra:up
npm run db:migrate
npm run db:seed
npm run access:setup
npm run access:demo
npm run dev:api
```

`access:setup` provisions restricted SQL/Mongo API identities using the administrative
root `.env`, preserving generated API passwords in ignored `.env.api`. `access:demo`
provisions three synthetic users and keeps their random login passwords in ignored
`.runtime/demo-accounts.json`. Both commands preserve existing credentials; neither
prints them. Never share either file. The API loads `.env` then `.env.api` and
requires the restricted identities when data access is enabled. Without setup,
liveness works but `/api/v1` returns 503 rather than using admin credentials.

## Endpoints

| Method/path                                  | Input                                                           | Result                                               |
| -------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| POST `/api/v1/auth/login`                    | JSON `{subject,password}`                                       | `{token,tokenType:"Bearer",expiresAt}`               |
| GET `/api/v1/auth/me`                        | Bearer header                                                   | Current user, roles and own linked student IDs       |
| POST `/api/v1/auth/logout`                   | Bearer header, JSON `{}`                                        | 204; session revoked                                 |
| GET `/api/v1/students/:studentId/transcript` | Bearer; optional `knownAt`, `effectiveAt` ISO8601 query strings | Scoped historical/current records                    |
| POST `/api/v1/records/:recordId/evidence`    | Bearer; UUID `Idempotency-Key`; version 1 JSON form             | 201 after SQL/Mongo confirmation; stable evidence ID |
| GET `/api/v1/evidence/:evidenceId`           | Bearer                                                          | Authorized, integrity-checked form                   |

Every POST requires `Content-Type: application/json`; compressed bodies are
unsupported. Unknown request fields and invalid UUID/timestamp inputs return 400;
oversized bodies return 413. Timestamps support up to six fractional digits and
an explicit UTC/offset suffix. Numeric grades/credits are returned as decimal
strings to preserve database precision.

## PowerShell walkthrough

Keep the API running in one terminal. In a second terminal at the repository root:

```powershell
$accounts = Get-Content .runtime/demo-accounts.json | ConvertFrom-Json
$student = $accounts | Where-Object subject -eq 'demo:student'
$session = Invoke-RestMethod http://127.0.0.1:4000/api/v1/auth/login -Method Post `
  -ContentType 'application/json' -Body (@{ subject = $student.subject; password = $student.password } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($session.token)" }
$me = Invoke-RestMethod http://127.0.0.1:4000/api/v1/auth/me -Headers $headers
$studentId = $me.students[0].studentId
$transcript = Invoke-RestMethod "http://127.0.0.1:4000/api/v1/students/$studentId/transcript" -Headers $headers
$transcript.records

$recordId = $transcript.records[0].record_id
$headers['Idempotency-Key'] = [guid]::NewGuid().ToString()
$form = @{ schemaVersion = 1; category = 'supporting_note'; data = @{ note = 'Synthetic demonstration only'; source = 'demo' } } | ConvertTo-Json -Depth 4
$receipt = Invoke-RestMethod "http://127.0.0.1:4000/api/v1/records/$recordId/evidence" `
  -Method Post -Headers $headers -ContentType 'application/json' -Body $form
Invoke-RestMethod "http://127.0.0.1:4000/api/v1/evidence/$($receipt.evidenceId)" -Headers $headers
Invoke-RestMethod http://127.0.0.1:4000/api/v1/auth/logout -Method Post `
  -Headers $headers -ContentType 'application/json' -Body '{}'
```

Retain the same idempotency key and body when retrying a failed upload. Use a new
key for new evidence. Do not print/store bearer tokens in shared terminal captures.

Read the [access/evidence design](../architecture/access-and-evidence.md) for role
scope, digest encoding and failure semantics. Controlled academic changes are
described below; the student walkthrough itself submits evidence only.

## Controlled academic changes - Week 4

Two different active registrars in the record's institution are required. One
proposes; the other approves/applies or rejects. Students/examiners cannot use
these routes, and auditors can only read request status in their institution.
This is a prototype policy, pending institutional review.

| Method/path                                       | Input/result                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET `/api/v1/records/:recordId/change-context`    | Institutional registrar only; `{recordId,latestRecordedVersion}` for proposal preparation |
| POST `/api/v1/records/:recordId/change-requests`  | Bearer + UUID `Idempotency-Key`; proposal JSON below; 201 with immutable request/status   |
| GET `/api/v1/change-requests/:requestId`          | Scoped request, decision, current revision/staleness and delivery states                  |
| POST `/api/v1/change-requests/:requestId/approve` | JSON `{reason}`; 202 after atomic SQL acceptance                                          |
| POST `/api/v1/change-requests/:requestId/reject`  | JSON `{reason}`; 200 with immutable rejection; no grade append                            |

```json
{
  "expectedVersion": 0,
  "gradePoints": "8.00",
  "outcome": "passed",
  "validFrom": "2026-01-01T00:00:00.000000Z",
  "validUntil": null,
  "evidenceId": "00000000-0000-0000-0000-000000000001",
  "reason": "Synthetic initial result for review"
}
```

The example evidence ID is a placeholder: use a real `available` evidence receipt
bound to the target record. Grade points are decimal strings (at most two decimal
places), or null for `withdrawn`/`incomplete`. Version 0 issues the first result;
corrections use the latest recorded version from `change-context` as their
precondition. This read is advisory: a concurrent approval can still make a
proposal stale, and SQL checks the precondition again at approval. Valid-time
queries still distinguish future/partial corrections from current-effective grades.

Same-key proposal retries with the same semantic numeric/time values and other
fields return the original request. Changed input conflicts. Approval/rejection
retries must have the same actor, decision and reason. A stale version returns 409;
review the new head rather than blindly retrying an outdated proposal.

202 confirms a committed academic transition with durable outbox work. It does not
claim Mongo availability, projection delivery or signed-credential publication.
Delivery status reports safe errors/attempts without exposing worker lease tokens.
See the [workflow contract](../architecture/record-workflow.md) for atomicity,
privilege and trust boundaries. Requests cannot supply an actor or institution ID.

## Verification commands

```powershell
npm run check
npm run build
npm run test:db
npm run test:integration
npm run access:smoke
npm run worker:setup
npm run workflow:demo
npm run workflow:smoke
```

The integration harness creates isolated SQL/Mongo databases and restricted
temporary identities, runs real HTTP requests, then removes only its own resources.
It requires the administrative local services, not a running development API.
Interrupted runs can leave temporary resources; inspect their UUID names before
manual cleanup. GitHub CI defines the same checks with disposable service containers.

`access:smoke` instead uses the explicitly provisioned local demo after a build.
It starts/stops a temporary compiled server and adds one synthetic evidence note
to the demo record. It checks the actual packaged API, including seeded IDs; it
does not reset local data. CI performs this demo against its disposable services.

`workflow:demo` adds two distinct synthetic registrars and a separate synthetic
record. It preserves passwords in ignored `.runtime/workflow-accounts.json` and
record metadata in `.runtime/workflow-fixture.json`. `workflow:smoke` starts a
temporary compiled API, stages evidence, proposes a change, approves as the second
registrar and confirms delivery using the restricted worker. Each run appends one
synthetic version; it does not reset history. Run it without another worker
processing this local demo queue. Neither command prints credentials or tokens.
See the [worker guide](../../apps/worker/README.md) for retry and replay limits.
