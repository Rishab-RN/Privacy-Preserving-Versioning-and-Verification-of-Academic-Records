# Architecture

The project owner will provide the ER and data-flow diagrams. No replacement
diagrams are generated. Diagram review remains open.

At the owner's request to proceed to Week 2, the written specification is now
implemented as a [provisional academic model](academic-model.md). It documents SQL
authority, keys, temporal semantics, prototype grading assumptions and access
limits. Reconcile it with the owner's diagrams and grading rules before extending
the workflows. Implemented behaviour is not institutional-policy approval.

Record diagram versions and review status here when the owner supplies them.

The [normalization review](normalization.md) covers migrations `0001`-`0005`,
candidate keys, functional dependencies, logical decompositions and intentional
physical exceptions. It does not claim every physical table is in 3NF/BCNF or
replace institutional-policy review.

The [Week 4 record workflow](record-workflow.md) defines distinct-registrar
approval, the atomic SQL change/audit/outbox boundary and recoverable derived
delivery. Its SQL/API/worker updates have separate validation and commit points.

The [Week 3 access/evidence design](access-and-evidence.md) records the local
identity adapter, authorization matrix, restricted database identities, document
encoding and recoverable SQL/Mongo staging protocol. It preserves the pending
academic-policy review and does not introduce grade-write APIs.

The owner confirmed [mandatory capabilities](required-capabilities.md) on
23 November 2026: cryptographic tamper verification, Neo4j provenance and Python
ML anomaly detection. ZK/vector decisions remain use-case based. Earlier optional
graph/ML language is superseded; the capabilities are not yet implemented.
