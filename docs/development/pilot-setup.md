# Synthetic pilot institution

`npm run pilot:setup` seeds the CD252IA marks-to-results pilot into the local development
database from `generatePilotData()` (`packages/pilot-data`). Every person, USN and mark is
synthetic.

It creates a separate institution, `ARDC` (Academic Records Demo College), so existing demo
data is untouched:

| Facts     | Contents                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue | Programmes BE-AI and BE-IS, term `2026-27-ODD`, grading scheme `RVCE-2022-ABS10` (pass 4.00), course CD252IA                                        |
| Offerings | Sections AI-A, AI-B and IS-A, mapped to the AI and IS reviewing departments (migration `0016`)                                                      |
| Students  | 28 students (`SYN24AI001`…, `SYN24IS001`…) with programme membership and enrolments                                                                 |
| Accounts  | 42 logins with institutional roles: 14 staff personas (`pilot:f1`, `pilot:h1`, …) and every student (`pilot:syn24ai001`, …)                         |
| Duties    | Course teacher and SEE examiner duties, HoD and delegate duties, and S1's roster delegation, all matching `PILOT_WORLD` in `packages/access-matrix` |

Apply migrations through `0016` first. From the repository root:

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

## Limits

- Migration `0016` models roster delegations only. S2's `validate_import` delegation, marks
  batches, review and publication arrive with the following slices.
- Delegation windows use the fixture dates. S1's roster delegation is valid until 2027-02-01.
- The script runs against the configured development database with the administrative `.env`
  credentials. It is not a production provisioning tool.
