# Synthetic pilot institution

`npm run pilot:setup` seeds the CD252IA marks-to-results pilot into the local development
database from `generatePilotData()` (`packages/pilot-data`). Every person, USN and mark is
synthetic. To walk through the pilot in the web app, follow the
[pilot demo](pilot-demo.md). The API calls below show the same steps without the screens.

It creates a separate institution, `ARDC` (Academic Records Demo College), so existing demo
data is untouched:

| Facts     | Contents                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue | Programmes BE-AI and BE-IS, term `2026-27-ODD`, grading scheme `RVCE-2022-ABS10` (pass 4.00), course CD252IA                                        |
| Offerings | Sections AI-A, AI-B and IS-A, mapped to the AI and IS reviewing departments (migration `0016`)                                                      |
| Students  | 28 students (`SYN24AI001`…, `SYN24IS001`…) with programme membership and enrolments                                                                 |
| Accounts  | 42 logins with institutional roles: 14 staff personas (`pilot:f1`, `pilot:h1`, …) and every student (`pilot:syn24ai001`, …)                         |
| Duties    | Course teacher and SEE examiner duties, HoD and delegate duties, and S1's roster delegation, all matching `PILOT_WORLD` in `packages/access-matrix` |
| Policy    | Each section's frozen assessment policy, `rvce-2022-itl-s1` version 1 (migration `0017`), and the S1/S2 validation delegations (migration `0018`)   |

Apply migrations through `0022` first. From the repository root:

```powershell
npm run db:migrate
npm run pilot:setup
```

The first run writes random passwords to ignored `.runtime/pilot-accounts.json` and public IDs
to ignored `.runtime/pilot-fixture.json`. A repeated run changes nothing. Existing passwords are
verified and never reset; a conflicting fact stops the run without overwriting anything. Keep the
accounts file private and out of screenshots.

## Try the roster

Sign in through the API with a subject and password from the accounts file, then read rosters
with the bearer token:

```powershell
$accounts = Get-Content .runtime/pilot-accounts.json -Raw | ConvertFrom-Json
$f1 = $accounts | Where-Object subject -eq 'pilot:f1'
$login = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/v1/auth/login `
  -ContentType 'application/json' -Body (@{ subject = $f1.subject; password = $f1.password } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Uri http://127.0.0.1:4000/api/v1/pilot/offerings -Headers $headers
```

Expected results:

| Signed in as            | Rosters                                            |
| ----------------------- | -------------------------------------------------- |
| F1                      | AI-A only (12 students)                            |
| H1, H2                  | AI-A and AI-B                                      |
| S1                      | AI-A and AI-B through the active roster delegation |
| P1                      | All three sections                                 |
| D1, A1, R1 and students | 403: no roster grant                               |
| F1 asking for IS-A      | 404: outside scope                                 |

`tests/integration/pilot-setup.test.ts` provisions a disposable database twice and checks these
outcomes for every persona against `PILOT_WORLD`.

## Enter marks

With the same F1 token, `POST /api/v1/pilot/offerings/<AI-A offering ID>/batches` creates a CIE
revision. Send an `Idempotency-Key` header and a body with `stage`, `expectedRevision` (0 for the
first), `components` and one row of values per enrolment. Then
`POST /api/v1/pilot/batches/<batch ID>/submit` submits it. The offering IDs are in
`.runtime/pilot-fixture.json`. The rules, errors and read scope are in
[pilot marks batches](../architecture/assessment-batches.md).

## Review and validate

After F1 submits the AI-A CIE revision:

| Signed in as | Request                                       | Result                                         |
| ------------ | --------------------------------------------- | ---------------------------------------------- |
| S1 or S2     | `GET /api/v1/pilot/validation-queue`          | The submitted head, until someone validates it |
| S1           | `POST /api/v1/pilot/batches/<ID>/validate`    | 200 with the missing-row count                 |
| H1 or H2     | `GET /api/v1/pilot/review-queue`              | The submitted CIE head                         |
| H1 or H2     | `POST .../review` `{"verdict":"approved"}`    | 200; F1 can no longer add a revision           |
| H1 or H2     | `POST .../review` `{"verdict":"returned", …}` | Needs a `reason`; F1 may then add a revision   |
| H1           | Review the AI-B revision H1 entered           | 403 `SELF_REVIEW`                              |

A revision gets one review, so approval and return are alternatives.

## Publish results

Once the AI-A CIE head is approved and E1 has submitted the SEE head, P1 publishes with
`POST /api/v1/pilot/offerings/<AI-A offering ID>/publish`. The body is
`{"attendance": [{"enrolmentId": "…", "eligible": true, "percent": "91.5"}, …]}`, with one entry
per enrolled student. Then:

| Signed in as        | Request                              | Result                                                  |
| ------------------- | ------------------------------------ | ------------------------------------------------------- |
| P1                  | `GET .../offerings/<ID>/publication` | 12 results and `audit.mismatches: []`                   |
| F1, H1, H2, R1, A1  | The same view                        | 200                                                     |
| SYN24AI001          | `GET /api/v1/pilot/my-results`       | CD252IA, grade A, 8.00, labelled Provisional            |
| AI-B and IS-A users | `GET /api/v1/pilot/my-results`       | No CD252IA result                                       |
| H1 or E1            | `POST .../publish`                   | 403: exam approvers only                                |
| P2                  | `POST .../publish` for IS-A          | 403 `SOD_CONFLICT` once P2 has reviewed or validated it |

The rules and the audit are in [pilot result publication](../architecture/result-publication.md).

## Correct a result after paper viewing

SYN24AI003 fails CD252IA in the provisional results. After paper viewing, the expert team raises
`see_part_b` from 20 to 26. R1 submits the revaluation:

- Request: `POST /api/v1/pilot/records/<record ID>/pvp`, with an `Idempotency-Key` header.
- Body: `{"expectedVersion": 1, "revised": {"see_part_b": "26"}, "reason": "…"}`.
- The record ID is in the publication view.

R2 then approves the returned request with `POST /api/v1/change-requests/<request ID>/approve`.
The result becomes version 2 with grade B+ and is marked `revisedAfterPvp`. The student can then
request a private proof for it.

Refused requests:

- A lab component returns 422 `PVP_LAB_EXCLUDED`.
- A lower mark returns 422 `NO_NEGATIVE_EVALUATION`.
- R1 cannot approve their own request.

The rules are in [paper-viewing corrections](../architecture/pvp-corrections.md).

## Limits

- The paper-viewing window has no stored dates; the exam approver declares results final.
- Delegation windows use the fixture dates. S1's roster delegation is valid until 2027-02-01.
- The script runs against the configured development database with the administrative `.env`
  credentials. It is not a production provisioning tool.
