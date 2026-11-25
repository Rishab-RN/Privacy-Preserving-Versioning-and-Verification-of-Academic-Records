# Frontend walkthrough and acceptance boundary

Run the [web application](../../apps/web/README.md) after API setup. This UI uses
live SQL/Mongo-backed endpoints. It has no sample-data fallback when a service or
permission check fails.

| Screen                        | Show in the demo                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in                       | Use the assigned subject/password; show a generic invalid-login response without exposing credentials                                                        |
| Overview                      | Select an accessible student; metrics reflect that student's visible transcript query, with no invented activity/chart data                                  |
| Records                       | Search a course code, inspect recorded versions, apply known/effective time filters, then return to the current view                                         |
| Evidence                      | Submit a supporting note for a record; show its available reference/digest and retrieve the integrity-checked content                                        |
| Proposal (registrar)          | Use that evidence reference, outcome, effective interval and reason; submit for independent review and retain the request ID                                 |
| Review                        | Proposer can inspect but cannot approve their own request; sign in as a second registrar, enter the request ID, inspect facts and confirm approval/rejection |
| Delivery/history              | Show the immutable decision separately from pending/delivered Mongo projections; refresh status after the worker runs                                        |
| Private proofs (student)      | Issue against the latest independently approved course result, consent to a threshold and generate a real ZK proof in a browser worker                       |
| Public verifier               | Upload the shareable proof, check issuer/proof/live SQL status and consume its one-use challenge; inspect the signed acceptance receipt                      |
| Credential status (registrar) | Revoke an institutional proof credential with an immutable reason; subsequent online acceptance fails                                                        |

Use the workflow fixture's record ID from ignored
`.runtime/workflow-fixture.json` when demonstrating a registrar correction. Share
the resulting request ID with the second registrar, not their session token.
Auditors can read scoped records and review status but cannot submit evidence or
decisions. Students can read their own transcript and submit evidence; registrar
proposal/review controls are absent.

Time fields use the browser's local time and are sent as ISO timestamps. The API
continues to determine authorisation, academic grading bounds, available evidence,
independent actors and concurrent expected-version checks. Native required/type/
length checks help entry but do not replace those server rules.

After acceptance, return to Records and choose **Current view** to observe the new
recorded version. Earlier known-at queries remain available. A future-effective
correction can be the latest recorded revision while today's effective answer
still differs. Pending document delivery does not make a committed grade vanish.

Run `npm run worker:once` from a separate terminal to deliver queued Mongo
projections; the UI cannot run privileged administrative commands. It can refresh
and display the safe delivery status. Signed-log publication and audit still use
their separate operator commands and keys.

## Checks before advancing

The root build compiles the production frontend; typechecking includes pages and
browser tests. `npm run test:integration` verifies the new directory cannot reveal
another student's/institution's identifiers. `npm run test:web` verifies a complete
live browser flow, including a genuine lost HTTP response after proposal commit.
The retry uses the same exact body/key and retrieves the first request.

Desktop and 390-pixel mobile screenshots are written to ignored local runtime
storage. Table overflow is contained and keyboard-focusable, controls have explicit
labels/descriptions, error/status messages use live semantics, keyboard focus is
visible, and a skip link and reduced-motion rules are included. This is not a claim
of a full accessibility audit or all-browser certification.

The owner requires UI work before moving to the next week. The connected ZK flow
now includes approved-version persistence, local holder secrets, nonce consumption,
live currentness and registrar revocation, with real browser tests. See the
[ZK demo](zero-knowledge-demo.md) for exact steps and trust limits. SD-JWT remains
a separate library; graph/ML and their reviewer screens remain mandatory later
milestones. Passing the ZK gate does not claim those modules are implemented.
