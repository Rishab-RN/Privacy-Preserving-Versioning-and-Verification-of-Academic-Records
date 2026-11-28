# Pilot demo: marks to a corrected result

This walkthrough follows CD252IA section AI-A from marks entry to a published result, then to a
paper-viewing correction. Everything is synthetic. Each step uses a different pilot account,
and every person sees only the desks their duties allow under **Marks & results**.

## Before you start

From the repository root, with the local services running:

```powershell
npm run db:migrate
```

```powershell
npm run pilot:setup
```

If you have not created the restricted runtime identities yet, run `npm run access:setup` once
(see the README). Then start the API and the web app in two terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

Open the web app and sign in with subjects and passwords from the ignored
`.runtime/pilot-accounts.json`. Keep that file private and out of screenshots. The walkthrough
needs a pilot whose AI-A marks have not been entered yet.

## Walkthrough

| Step | Sign in as                    | Where             | What to do                                                                                   | What you should see                                                 |
| ---- | ----------------------------- | ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1    | `pilot:f1` (course teacher)   | Marks entry       | Enter CIE marks for the 12 students, **Save revision**, then **Submit revision 1**           | "Submitted for department review."                                  |
| 2    | `pilot:s1` (exam section)     | Exam office       | Add a note and **Record validation** for the AI-A CIE revision                               | "0 enrolled students have no row"                                   |
| 3    | `pilot:h1` (AI HoD)           | Department review | **Open** the AI-A revision, then **Approve revision** (or return it with a reason)           | The revision leaves the queue, locked for publication               |
| 4    | `pilot:e1` (SEE examiner)     | Marks entry       | Enter SEE marks (`AB` for an absent student), save and submit                                | "Submitted to the exam section for publication."                    |
| 5    | `pilot:p1` (CoE approver)     | Publication       | Paste attendance as `USN, percent, yes/no`, apply it, then **Publish provisional results**   | 12 results and "Audit: all 12 grades recompute"                     |
| 6    | `pilot:syn24ai001` (student)  | My results        | Open the CD252IA card                                                                        | Grade, grade points and the CIE/SEE breakdown, labelled Provisional |
| 7    | `pilot:r1` (registrar)        | Paper viewing     | **Revalue SYN24AI003**, raise `see_part_b` from 20 to 26, give a reason and file the request | "Correction request filed" with the request ID                      |
| 8    | `pilot:r2` (second registrar) | Review            | Find the request ID, add a reason, **Approve correction** and confirm                        | A new grade version is committed                                    |
| 9    | `pilot:syn24ai003` (student)  | My results        | Open the CD252IA card                                                                        | B+, version 2, "Revised after paper viewing"                        |

Things the screens refuse, as the API does:

- H1 never sees their own AI-B revision in the review queue.
- IS-A drops out of P2's Publication list once P2 has reviewed or validated it.
- A lab component or a lower mark cannot be revalued.
- R1 cannot approve their own correction.

After step 9, SYN24AI003 can open **Private proofs** and request a grade-threshold credential
for the corrected record, when the ZK setup (`npm run zk:setup`) is configured.

## Automated journey

`tests/browser/pilot.spec.ts` runs these nine steps in a real browser as part of
`npm run test:web`. It uses its own API and web preview processes, signs in nine times, and
saves screenshots to `.runtime/frontend-evidence/pilot-*.png`. CI runs `npm run pilot:setup`
first. Locally, the journey skips itself when AI-A already has marks, because pilot facts are
append-only and cannot be reset.
