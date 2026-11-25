# Web application

The React/TypeScript/Tailwind application is runnable and connected to the existing
API. It includes sign-in, role-scoped overview, student selection, course search,
historical transcript filters, supporting evidence, registrar proposals and
independent approval/rejection with delivery status. Pages and shared controls are
separate modules under `src/`; transport types come from `packages/contracts`.

From the repository root, keep the API running in one terminal and the frontend
in another:

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the loopback API on port 4000;
`WEB_API_PORT` can select another local API port. Both development and build-preview
use this proxy. No database credentials belong in a `VITE_*` variable.

For initial local setup, follow the [API guide](../../docs/development/api.md).
Synthetic login details remain in ignored `.runtime/demo-accounts.json` and
`.runtime/workflow-accounts.json`; open those locally and use the account subject
and password. Never include them in shared captures. No password is embedded in
the frontend. Students see their own linked subject; registrars/auditors select
subjects within their institution. Controls reflect roles while the API still
enforces every permission.

The session token and retry state stay in memory, without local/session storage.
Refresh requires sign-in. A 401 or session expiry clears the workspace; failed
logout reports when server-side revocation could not be confirmed. Evidence and
proposal retries preserve their exact body/key while the same form remains open.
Navigating away or refreshing clears that in-memory retry state.

`npm run build` includes the frontend production bundle. `npm run preview:web`
previews it on port 5173; this is a local preview, not a production hosting setup.
The development `.env` files remain server-only and are never bundled.

## Browser validation

After access/worker/workflow fixture setup:

```powershell
npx playwright install chromium
npm run test:web
```

The test starts its own API on 4017 and production preview on 5177, refuses to
reuse occupied servers, and stops them afterwards. It uses local synthetic demo
accounts and appends evidence plus one approved correction to the synthetic
workflow record on each successful run. It does not reset history. Run against
disposable services in CI. For local Chrome, set `WEB_BROWSER_EXECUTABLE` to its
installed executable instead of downloading Chromium.

The journey covers bad login, scoped student view, historical/empty/search states,
network failure and recovery, mobile overflow, read-only auditor controls,
evidence retrieval, a lost proposal response with exact retry, blocked self-review,
approval confirmation/cancellation, distinct-registrar acceptance, revised-version
rendering, 401 expiry and memory-only sessions. Screenshots are ignored under
`.runtime/frontend-evidence`; no screenshots or traces capture entered passwords.

Private proofs now connects approved-version issuance, browser-local Groth16
proving, a public verifier with one-use online status checking and registrar
revocation. Complete `npm run zk:setup` and migrate through `0013` before testing
these pages; restart the API to load `.env.zk`. The expanded browser suite checks
real proving, public payloads, tampering/replay/revocation and mobile overflow.
See the [ZK demo](../../docs/development/zero-knowledge-demo.md).

The separate SD-JWT cryptographic library is not a deployed service. Neo4j and ML
screens remain later work; their success is not simulated. See the
[frontend walkthrough](../../docs/development/frontend.md).
