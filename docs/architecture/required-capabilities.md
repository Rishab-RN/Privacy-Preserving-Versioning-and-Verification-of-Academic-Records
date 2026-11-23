# Required verification, graph and anomaly capabilities

Owner decision, 23 November 2026: tamper verification, anomaly detection, Neo4j and
Python ML are mandatory project deliverables. Earlier descriptions of graph/ML as
optional extensions are superseded. ZK predicates and vector search are assessed
separately against concrete use cases. This decision defines required behaviour;
it does not claim those modules are already installed or implemented.

## Responsibility and authority

| Component            | Required responsibility                                                                 | Authority boundary                                                                |
| -------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| PostgreSQL           | Normalised academic facts, versions, access/approval decisions, audit and outbox events | Authoritative academic state                                                      |
| MongoDB              | Bounded heterogeneous evidence/documents with immutable SQL references and digests      | Document content; no competing transcript state                                   |
| Verification package | Canonical commitments, signatures, Merkle proofs and retained-checkpoint verification   | Verify declared integrity/currentness properties under explicit trust assumptions |
| Neo4j                | Correction/approval/evidence provenance and relationship-based queries/features         | Rebuildable, access-controlled SQL-event projection                               |
| Python ML pipeline   | Rules, model-based anomaly ranking, explanations and evaluation                         | Advisory risk triage; cannot approve grades or override an integrity failure      |

## Mandatory tamper verification

Implement a precisely encoded commitment/signature/log profile and an independent
verification path. Recompute commitments from actual payload bytes, not only saved
hash columns. Bind credential, log and status evidence to the same artifact/version.
Retain accepted checkpoints outside the mutable state used in rollback tests.

Required cases include changed grade/evidence bytes, invalid signatures or Merkle
paths, deleted/reordered committed history and conflicting retained checkpoints.
Replay/currentness tests must distinguish a valid historical artifact from an
acceptable current one. Rollback/split-view detection depends on the retained
observations being available and trusted; document that condition explicitly.
No claim that a signature proves the factual truth of an entered grade.

Completion requires reproducible positive/negative fixtures, independent proof
verification and an integrated result that preserves separate integrity, status,
freshness and unavailable outcomes. The existing Week 3 SQL triggers and Mongo
digest checks are foundations, not completion of this requirement.

## Mandatory Neo4j provenance

Use stable opaque identifiers for institution, actor, student, course/offering,
correction request, approval, grade version and evidence entities. Project their
relationships from authoritative committed SQL events through the durable outbox.
Keep graph access scoped and limit copied personal data; opaque identifiers alone
do not provide anonymisation or unlinkability.

Required Cypher workloads:

- Trace a grade version through its correction, approver and evidence paths.
- Find repeated requester/approver pairings and concentrated upward corrections
  in a bounded time window.
- Identify reuse of an evidence reference/digest across multiple correction chains.
- Extract time-bounded relationship counts for anomaly features and show the
  supporting path to an authorised reviewer.

These queries identify relationships and review signals, not fraud verdicts.
Compare answers with equivalent SQL queries on the same fixtures. Test duplicate
delivery, out-of-order events, graph rebuild and unavailable/lagging Neo4j. An old
projection must not overwrite a newer one or become authority for a grade. Display
projection freshness; graph downtime must not silently change the academic record.
Measure latency/storage rather than assuming a graph database is always faster.

## Mandatory Python ML anomaly detection

Implement a reproducible synthetic event generator, transparent rules and an
Isolation Forest baseline. Include graph-derived features from Neo4j rather than
using Neo4j only as a visual demo. Candidate features include grade delta, correction
frequency, elapsed time, actor/course concentration, repeated approval pairings
and evidence reuse; freeze their exact definitions with the experiment.

Build each feature snapshot using only information available at that decision
time. Split chronologically and control correction-chain/actor overlap as required
by the evaluated question. Fit preprocessing/models on training data and choose
thresholds on validation data. Keep test labels and future graph relationships
out of feature construction. Include benign unusual changes and held-out anomaly
families so injected labels do not make the task trivial.

Required comparisons are rules alone, tabular ML and the same ML with graph-derived
features. Report PR-AUC, precision/recall at a declared review budget, false-positive
behaviour and per-family results, with fixed seeds and repeated runs. Synthetic
results support conclusions about the simulator, not real-university fraud rates.
Record training configuration, feature schema and model version with each result.

## Required integrated outcome

An authorised reviewer must be able to see the deterministic verification result,
anomaly ranking/explanation, supporting provenance path and projection/model
freshness. A low anomaly score cannot turn an integrity failure into success. A
cryptographically valid unusual correction can be flagged for review while
remaining validly issued; a risk score alone never changes an academic record.

All mandatory components need a working implementation, meaningful negative tests,
reproducible evaluation and the integrated demonstration before project completion.
If the schedule is tight, narrow data sizes, graph workloads or model complexity
while retaining these capabilities. Do not silently remove them or substitute
installation/screenshots for evidence. Research novelty remains a claim to evaluate.
