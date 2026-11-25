# Neo4j provenance

PostgreSQL commits the approved version, decision, event and outbox entry in one
transaction. Neo4j 5.26.33 projects accepted outbox events into a graph. The
projection has its own cursor. Academic state stays in PostgreSQL and MongoDB
delivery keeps its own acknowledgments.

| Node group                         | Relationships                                                                               | Stored data                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Institution, student, grade record | Institution has student. Student has record.                                                | Tenant-scoped IDs                                                                                                      |
| Institution, course, offering      | Institution has course. Offering is an instance of a course. Record belongs to an offering. | Tenant-scoped IDs                                                                                                      |
| Grade record and version           | Record has version. Version has a predecessor when one exists.                              | Record ID, revision number                                                                                             |
| Correction and actor               | Request resulted in a version. Separate actors proposed and approved it.                    | Request, event and actor IDs, event time, committed position, grade delta in hundredths when both versions are numeric |
| Evidence and digest                | Request uses evidence. Evidence has a SHA-256 digest.                                       | Evidence reference ID and digest                                                                                       |

Seed or administrative versions can appear as predecessors with unknown
workflow provenance. The graph excludes names, exact grades, sessions,
private proof witnesses, reasons and evidence bodies. IDs, digests and deltas
are sensitive review data.

## Order and recovery

Migration `0014` adds the restricted source and review functions without a new
physical PostgreSQL table. The worker scans the existing committed positions and
projects only `grade.accepted` events with outbox rows. Non-approval positions
advance the cursor without adding correction nodes. A source page with a gap,
unexpected order or unresolved approval fails without advancing.

Each batch locks its institution's graph cursor, compares it to the requested
start, and writes nodes, relationships and the new cursor in one transaction.
Concurrent or duplicate workers cannot regress the cursor. Unique node keys are
namespaced by institution. A predecessor can be created before its own acceptance
is projected. Idempotent merges attach that version's evidence when it arrives.
Batches contain up to 100 positions.

Rebuild reads one repeatable-read SQL snapshot with up to 10,000 positions and
replaces that institution's graph in one transaction. The cursor lock rejects
a snapshot behind an already advanced graph. Rebuild preserves other institutions.
A new Neo4j store can be recovered with the same outbox. Independent Merkle
verification continues through the signed-log operator.

## Query and access boundaries

`GET /api/v1/provenance/:institutionId` is available to a registrar or auditor for
that institution. Optional `recordId` and `version` parameters trace up to 21
revisions. A 30-day window powers tables for repeated proposer/approver pairs,
positive grade deltas by course, and reused evidence digests. Each group includes
up to five supporting request IDs. Each table returns up to 20 groups.

The API checks authorization in SQL before and after reading the graph. It shows
the observed committed position count, graph cursor and last sync time. Missing
positions produce a partial-result label. A failed graph query returns unavailable.
A graph ahead of PostgreSQL is rejected as inconsistent.

Feature extraction counts prior pairings and prior evidence-digest use over a
specified lower time bound. Both logged event time and committed position must
strictly precede the target. The feature counts feed the Week 9 model. Callers must
validate projection completeness for the observation window before training.

Neo4j Community is bound to loopback. The demo shares one graph account across
the worker and fixed API queries. The API enforces tenant scope and uses
parameterized Cypher. Deployment beyond the lab needs separately provisioned
read and write access. See the [Neo4j driver transaction manual](https://neo4j.com/docs/javascript-manual/current/transactions/).
