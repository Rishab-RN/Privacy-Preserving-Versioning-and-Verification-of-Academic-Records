# ScholarProof

**Privacy-Preserving Versioning and Verification of Academic Records**

A DBMS project exploring how academic records can be corrected, audited and shared
with verifiers while limiting unnecessary disclosure of student information.

**Status:** repository foundation. Application implementation has not started.
The project owner will provide the ER and data-flow diagrams before schema work
begins.

## Problem

Grades and transcripts change through revaluation and authorised corrections.
Verifiers need to distinguish an authentic historical record from the current
accepted version. Students should be able to share the information needed for a
verification request without routinely exposing an entire transcript.

## Intended capabilities

- Preserve academic record versions and explain authorised corrections.
- Enforce role-scoped access and approval workflows.
- Detect changes to committed records using hashes, signatures and Merkle proofs.
- Share selected claims with consent and holder-bound presentations.
- Report authenticity, supersession, revocation and evidence freshness separately.
- Recover asynchronous document and provenance updates without changing the
  authoritative academic state.

These are proposed capabilities, not completed features. Zero-knowledge predicates,
anomaly detection and graph analysis are extensions to evaluate after the core
workflow is working. Publication and novelty claims will depend on evidence.

## Planned technology

| Area | Direction |
|---|---|
| Frontend | React, TypeScript and Tailwind CSS |
| Backend | Node.js and TypeScript |
| Academic authority | PostgreSQL |
| Flexible evidence and document packages | MongoDB |
| Verification | Signed credentials, hashing and Merkle proofs |
| Optional research extensions | Python ML, Neo4j and bounded ZK predicates |

Final schema and service choices will follow the reviewed design. A valid signature
does not prove that an entered grade is factually correct; historical inclusion alone
does not establish currentness.

## Repository guide

```text
.github/                    Issue and pull-request templates
docs/
  architecture/             Reviewed diagrams and design documentation
  development/              Contributor and Git workflow documentation
  project-journey.md         Dated milestones and decisions
CONTRIBUTING.md              Collaboration and review conventions
```

Research downloads, planning drafts, local reports and temporary files are excluded
through `.gitignore`. Curated architecture documentation is maintained in `docs/`.

## Getting started

```powershell
git clone https://github.com/Rishab-RN/Privacy-Preserving-Versioning-and-Verification-of-Academic-Records.git
Set-Location Privacy-Preserving-Versioning-and-Verification-of-Academic-Records
```

This checkout currently contains documentation only. Runtime installation, database
setup and application commands will be added alongside the first implemented slice.
There are no application tests or running services to claim at this stage.

If you are using the existing `PrivacyPreservingRecords` working folder, its
`origin` is already configured; do not clone a second repository inside it.

## Collaboration

Use short-lived `feat/`, `fix/`, `docs/`, `test/` or `chore/` branches and pull
requests into `main`. Keep commits focused, with short Conventional Commit messages.
See [Contributing](CONTRIBUTING.md) and the
[Git workflow](docs/development/git-workflow.md), including the first commit for this
initially empty repository.

The project owner runs staging, commits and pushes manually. Automated assistants
must not run `git add`, `git commit` or `git push` unless that instruction changes.

## Project records

- [Project journey](docs/project-journey.md)
- [Architecture status](docs/architecture/README.md)
- [Contribution guidelines](CONTRIBUTING.md)

## Reference and attribution

The initial investigation considered
[RohanCB18/DBMS](https://github.com/RohanCB18/DBMS). Reference code is not included
in this repository. Any future reuse must preserve attribution and have established
licensing terms. A licence for ScholarProof has not yet been selected.
