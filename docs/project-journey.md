# Project journey

A dated record of meaningful milestones, decisions and evidence. This is not a list
of every edit. Completed work and future work are kept distinct.

## 2026-11-19 - Investigation and project direction

- Reviewed the initial academic-record project outline and reference repository.
- Identified record corrections, selective disclosure and verification freshness as
  the main engineering questions.
- Chose PostgreSQL as the proposed authority for structured academic state and
  MongoDB for flexible evidence/documents. Other stores remain optional.
- Established that Merkle trees and ZK credentials alone are not sufficient grounds
  for a novelty claim. Further comparison and measured results are required.

The reference repository was inspected statically; its reported runtime results
were not independently reproduced. Detailed research materials remain local and
are ignored by Git.

## 2026-11-20 - Repository foundation

- Cloned the empty GitHub repository into the existing project workspace and
  verified its `origin` and `main` branch.
- Added project documentation, contribution rules, Git workflow instructions and
  pull-request/issue templates.
- Excluded local research, planning drafts, temporary files and withdrawn diagram
  drafts through `.gitignore`.
- Assigned ER/DFD preparation to the project owner. The reviewed diagrams will
  precede database implementation.
- Kept staging, commits and pushes under the project owner's manual control.

No application, database migrations, deployment or performance results have been
implemented or claimed at this milestone.

## Next milestone

Review the owner-provided diagrams, agree on schema invariants, then implement a
small academic record issuance/correction workflow with appropriate validation.

## Entry format

For future milestones, record the date, concrete outcome, important decision and
verification evidence. Link the relevant PR/commit once it exists. Do not create
future-dated progress entries or mark planned work as complete.
