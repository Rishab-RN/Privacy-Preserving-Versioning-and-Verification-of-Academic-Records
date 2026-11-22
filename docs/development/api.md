# Week 3 API

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
scope, digest encoding and failure semantics. These endpoints do not approve or
apply academic corrections.

## Verification commands

```powershell
npm run check
npm run build
npm run test:db
npm run test:integration
npm run access:smoke
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
