# Zero-knowledge demo

Show a student proving **one approved course grade meets a minimum**, without
sharing its exact value with the verifier. This is separate from selective
disclosure. The current circuit is a course-grade predicate, not GPA.

## Prepare once

After the standard SQL/Mongo and API/worker setup, run from the repository root:

```powershell
npm run db:migrate
npm run zk:setup
npm run test:zk
npm run workflow:demo
npm run build
npm run workflow:smoke
```

`workflow:demo` provisions a separate synthetic course and two registrars;
`workflow:smoke` appends an independently approved grade of 8.00 to that record.
It must have the normal `.env.api` and `.env.worker` setup first, and no competing
worker for this smoke run. These commands preserve accounts/history. Rerunning
the smoke appends another synthetic revision and supersedes earlier proof credentials.
The workflow course is `DEMO_WORKFLOW`; find its record ID in ignored
`.runtime/workflow-fixture.json`. Seed-only grades are deliberately ineligible.

Setup creates ignored `.env.zk` with `ZK_ENABLED=true`, local circuit artifacts and
a separate issuer key pair. **Restart an API started before setup** so it loads
the flag. Start the API and web in separate terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

Open [the student workspace](http://127.0.0.1:5173/). Use `demo:student` and its
existing generated password; this command copies it without printing it:

```powershell
((Get-Content .runtime/demo-accounts.json -Raw | ConvertFrom-Json) |
  Where-Object subject -eq 'demo:student').password | Set-Clipboard
```

## Show the working proof

1. Open **Private proofs**. Choose the `DEMO_WORKFLOW` approved version and select
   **Issue private proof credential**. Explain that the issuer reads an immutable
   independently approved SQL version, rather than accepting a student-entered grade.
2. Download the **private wallet** if restoration is needed. Keep it private: it
   contains the exact grade, salt and secret. Navigation/reload clears memory.
3. Enter `8.00` and review **What the proof file shares**. For the signed-history
   demonstration, copy the credential ID and export its issuance evidence below.
   Select **Consent & generate ZK proof** to start the browser worker and the
   two-minute verification window.
4. Download the **shareable proof** and immediately open
   [the verifier](http://127.0.0.1:5173/verify) in another tab. Upload only the
   shareable proof and, if prepared, the signed issuance evidence.
5. Select **Verify proof**. Show **Verified · threshold met**, the version and
   the live check time. **Historical issuance** shows the checkpoint time and
   tree size. Download the signed acceptance receipt.
6. Select **Verify proof** again. Show that replay fails because SQL consumed the
   challenge once. Generate a fresh proof for another acceptance.

Say: “I can prove this approved course grade is at least 8 without sending its
exact value. The verifier checks the mathematical proof and issuer signature;
the server then checks current SQL status and consumes this one-time challenge.”

## Prepare signed issuance evidence

Set up the log operator with `npm run log:setup` once. After issuing the credential
in the student workspace, run these commands in an operator terminal.

```powershell
$logId = (Get-Content .runtime/workflow-fixture.json -Raw | ConvertFrom-Json).institutionId
$credentialId = Read-Host 'Credential ID shown by the student workspace'
npm run log:publish -- --log-id $logId
npm run log:export -- --log-id $logId --credential-id $credentialId --out ".runtime/log-demo/issuance-$credentialId.json"
```

Upload that JSON in **Signed issuance evidence (optional)**. The file contains
linkable issuance metadata and the opening of that single log entry. **Check
signed history only** verifies inclusion without consuming the challenge and
works after expiry or revocation. The portal defaults to the local operator's
public key. A separately provisioned PEM can be configured with
`ZK_LOG_PUBLIC_KEY_FILE` in `.env.zk`.

## Show failures and revocation

For tampering, generate another proof, alter one decimal digit of `proof.pi_a[0]`
in a **copy** of the shareable JSON, and verify it. It must fail; do not edit the
wallet or institution's real data. For an unsatisfied threshold, enter `9.00`
against the synthetic 8.00 result: generation is blocked. The raw circuit negative
tests establish enforcement independently of this UI precheck.

For revocation, generate a fresh valid proof but do not verify it yet. Retain the
credential ID. In a separate workspace sign in as `demo:registrar`, using its
existing password from `.runtime/demo-accounts.json`. Open **Credential status**,
enter the ID and a synthetic explanation, then select **Revoke credential
permanently**. Back in the public verifier, the unconsumed valid proof must fail
with a revoked-status response. Revocation is immutable; issue a new credential
for another demonstration. An approved newer version similarly supersedes older
credentials; past receipts remain as-of evidence, not proof of future currentness.

To demonstrate expiry, wait more than two minutes after generating a challenge
and submit its proof. It must be rejected; generate a fresh challenge afterward.
The integration suite tests both application and database clocks without waiting.

## Show code and tables briefly

| Show                                                  | Explain                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/zk/circuits/grade_threshold.circom`         | Private witness, public inputs, constrained inequalities and commitments       |
| `apps/web/src/zk.worker.ts`                           | Local proving and artifact-hash checks                                         |
| `apps/api/src/privacy-runtime.ts`                     | Authoritative issuance, issuer signature, independent verification and receipt |
| Migration `0012`, `privacy.consume`                   | Record lock, live expiry/currentness and unique one-use insert                 |
| `privacy.challenge` / `privacy.challenge_use`         | Threshold/nonce/creation separated from acceptance; fixed expiry computed      |
| `privacy.issuance_event` / `privacy.revocation_event` | Immutable event identities extend the existing signed history                  |

Do not display `privacy.credential.salt`, private wallets, credentials or issuer
private-key files to a verifier. Public proof JSON may be shown. The
[architecture](../architecture/zero-knowledge-proofs.md) lists all visible metadata
and remaining trust boundaries.

For the separate signed-log demo, deliver any normal workflow queue with
`npm run worker:once`, then use the operator's `log:publish` and `log:audit` commands
with the workflow fixture's institution as `--log-id` (see the operator guide).
The signer publishes credential events directly from the SQL log. The Mongo
queue continues to handle academic workflow events.

## Checks and honest project explanation

```powershell
npm run check
npm run test:zk
npm run test:db
npm run test:integration
npm run test:web
```

Browser checks need installed Chromium (`npx playwright install chromium`) or
`WEB_BROWSER_EXECUTABLE` pointing to an installed Chrome executable. They use the
provisioned local demo, append synthetic history and capture output in ignored
`.runtime/frontend-evidence`. Quality checks alone do not generate ceremony keys.

Say: “This is a working research prototype with a single-operator development
ceremony. Production would need an independently reviewed trusted setup and
security audit. ZK hides the exact grade; public identifiers remain linkable.
The proof establishes the selected predicate over an attested version, not that
the original university entry was factually correct.”

Keep the setup directory and issuer keys when retaining issued credentials.
Replacing them changes verifier trust and can make existing proofs/artifacts
unusable. Back them up securely; do not commit or upload them. The normal workflow
accounts, log signing keys and retained observations are preserved by setup.
