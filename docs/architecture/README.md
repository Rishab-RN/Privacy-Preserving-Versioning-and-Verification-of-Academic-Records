# Architecture

The owner supplied ER/data-flow diagrams and requested implementation-matched
college materials. Those local drafts are intentionally ignored. The repository's
written model and physical migration history define the current implementation;
draft diagrams are not assertions of official institutional policy.

The [academic model](academic-model.md) documents SQL authority, normalized
identities, temporal semantics, selected grading assumptions and access limits.
Implemented behavior is not institutional-policy approval.

The [normalization review](normalization.md) covers the forward BCNF decomposition
in migrations `0008`/`0009` and the `0010`-`0012` transparency/private-proof extensions: 31 domain tables, candidate keys, identified
functional dependencies, explicit 1NF/2NF/3NF/BCNF results and lossless reconstruction
through read views. It supersedes the earlier twenty-table physical-exception
analysis. Migration/upgrade/runtime acceptance and rollout are tracked separately
in the journey; a table classification alone does not prove runtime integrity.

The [transparency log](transparency-log.md) adds transactional institutional order,
private salted commitments and signed checkpoints. The
[operator](../../apps/log/README.md) and
[offline verifier](../../packages/verification/README.md) document independent
proof checking and retained-observation limits. Historical inclusion does not
establish current credential status.

The [Week 6 credential profile](credential-profile.md) defines the implemented
flat-claim SD-JWT library, pinned trust, exact consent and holder/Merkle binding.
That SD-JWT library remains stateless. The separate
[zero-knowledge grade profile](zero-knowledge-proofs.md) now has approved-version
issuance, private holder witnesses, SQL persistence, revocation/supersession,
single-use online acceptance and a connected browser prover/verifier. It does not
silently turn the SD-JWT library into a deployed issuance service.

The [Week 4 record workflow](record-workflow.md) defines distinct-registrar
approval, the atomic SQL change/audit/outbox boundary and recoverable derived
delivery. Its SQL/API/worker updates have separate validation and commit points.

The [Week 3 access/evidence design](access-and-evidence.md) records the local
identity adapter, authorization matrix, restricted database identities, document
encoding and recoverable SQL/Mongo staging protocol. It preserves the pending
academic-policy review and does not introduce grade-write APIs.

The owner confirmed [mandatory capabilities](required-capabilities.md) on
23 November 2026: cryptographic tamper verification, Neo4j provenance and Python
ML anomaly detection. On 25 November the owner also made ZK mandatory before
Week 7. Its implemented predicate is the approved course-grade threshold. Vector
search remains use-case based. The [Week 8 Neo4j projection](provenance.md)
provides scoped provenance, repeatable queries and recovery. The
[Week 9 anomaly review](../development/anomaly-demo.md) describes decision-time
features, experimental baselines and the read-only reviewer workflow.
The [Week 10 integrated demo](../development/integrated-verification-demo.md)
describes the scoped approval check, offline checkpoint witness and cross-store
recovery scenarios.
