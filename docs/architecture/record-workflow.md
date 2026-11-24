# Record changes and durable delivery - Week 4

This defines the complete Week 4 contract. SQL, API and worker implementation
updates are reviewed and committed separately; the journey records which slices
have been verified. It is not a claim that one migration implements the whole app.

The BCNF follow-up uses forward migrations `0008`/`0009` to normalize storage while
preserving this HTTP/event contract. Existing data/history must survive the upgrade;
acceptance results are recorded separately in the journey. The physical request
derives its record through evidence, the event derives it through the request, and
context views reconstruct those identities without stored redundant columns.

This is a prototype approval policy, not a statement of official institutional
rules. One active registrar proposes an initial result or correction; a different
active registrar in the same institution approves/applies or rejects it. Students
retain their scoped transcript/evidence access. Auditors can read institutional
request status but cannot decide. Examiners receive no grade-write access until
course/staff assignments are explicitly modelled. There is no self-withdraw path.

## Immutable requests and decisions

`workflow.change_request` freezes expected revision, proposed grade/outcome,
valid-time interval, reason and available evidence reference. The target record is
resolved through that immutable reference rather than copied into the request. A UUID
idempotency key is unique per proposer. Equivalent numeric/time values and the same
remaining inputs return the original request, including after the head advances;
different input under that key conflicts. A proposal alone does not change a grade.

`workflow.decision` stores one immutable approved/rejected result per request.
Its physical nullable version result identifies approval versus rejection; the
read interface computes that label rather than storing the same state twice.
Exact decision retries by the same actor/reason return the stored outcome; another
decision conflicts. Rejection creates no grade version. A stale expected revision
cannot be approved; another request must be reviewed against the accepted head.

Record identity and offering academic identity, credits and grading policy are
frozen once a proposal references them. Existing versioned schemes remain
immutable. This preserves the context of an initial-result proposal before the
first grade would activate the older grade-used offering guard.

## Atomic approval boundary

The SQL wrapper resolves an active session/account, checks live institutional
registrar scope, and locks the record before the request. It checks distinct
proposer/approver, current expected revision and bound available evidence, then:

1. Appends the immutable grade using the existing temporal/policy guards.
2. Updates the record head and bitemporal projection through those triggers.
3. Stores the immutable approval decision.
4. Inserts an immutable audit/domain event and its outbox delivery.

All effects commit in one SQL transaction. A failing audit/outbox insertion rolls
back the grade, head, projection and decision as well. The grade's `author_id` is
the approving/applying registrar; its academic reason is the frozen proposal
reason. The separate decision reason records the approver's review comment.

Evidence must already have an immutable SQL digest/reference in `available`, bound
to this record. Approval uses that previously confirmed manifest, without a live
Mongo dependency or a distributed transaction. It does not assert that Mongo is
currently readable. Evidence reads still verify bytes against the frozen digest;
missing/altered content remains a separately reported failure. Later signatures
and retained checkpoints provide the independent verification stage.

## Permissions and trust

The API receives execution rights on four workflow wrappers, not direct table
writes, raw grade append, queue acknowledgement or membership in the function
owner. A dedicated `NOLOGIN`, non-superuser owner has only the rights needed by
the wrappers and grade triggers. Fixed search paths, qualified names and revoked
PUBLIC execution protect the function boundary; see [PostgreSQL function security](https://www.postgresql.org/docs/18/sql-createfunction.html).

The wrapper's session digest is authenticated server context, not a client body
identity. Existing API database privileges can verify/create sessions: a stolen
API database credential can therefore impersonate application users. Distinct
account enforcement is an HTTP/application policy, not cryptographic individual
non-repudiation or protection against a compromised API service/database owner.
Administrators can also replace triggers/functions. Those limits remain explicit.

## Retained audit and outbox

`workflow.domain_event` retains `request.submitted`, `request.rejected` and
`grade.accepted` envelopes. Each has a stable event/request/record identity,
institution, actor, proposer, evidence digest/size, proposal/decision metadata and,
when accepted, the exact grade revision. Decimal grade values and microsecond
timestamps are serialized as strings. Capturing rejected/proposed history now
supports the mandatory later Neo4j and ML consumers.

UUIDs and database timestamps are not a global committed log order. Week 5 must
define its signed log prefix/order independently. Events are not currently signed
credentials or externally trusted checkpoints.

`workflow.outbox_delivery` is keyed by event ID for the implemented
`mongo-records-v1` consumer. The fixed consumer name is computed by the read
interface rather than stored with every delivery.
Absent Neo4j/ML handlers are not marked delivered; their later consumers can
backfill the retained journal. Claims use bounded batches, `FOR UPDATE SKIP LOCKED`
and expiring random leases. Only the matching unexpired token can acknowledge or
fail a claim; an old worker cannot complete a reassigned lease. The locking pattern
is documented by [PostgreSQL SELECT](https://www.postgresql.org/docs/18/sql-select.html).

Failures retain a small allowlisted code and exponential retry delay capped at
300 seconds. Eight actual failures quarantine a delivery. Claim attempts and
failure counts are separate: expiry/reclaim does not itself consume the failure
budget. Quarantined work remains visible and requires explicit operator diagnosis;
it is never silently discarded. GET status excludes worker lease tokens.

## Derived Mongo projection

The restricted worker writes immutable event receipts and accepted grade revision
copies, then atomically advances a latest-recorded-version pointer. Mongo
acknowledgement precedes SQL completion. A crash between them causes replay;
identical writes are idempotent and different data under an existing identity is
surfaced as a conflict. Late events cannot regress the pointer. Conditional updates
use a [Mongo aggregation update pipeline](https://www.mongodb.com/docs/manual/tutorial/update-documents-with-aggregation-pipeline/).

The pointer is **latest recorded**, not current-effective grade. Partial/future
corrections still require authoritative SQL temporal queries. Only workflow events
are projected; legacy administrative seed appends do not magically gain audit
events or graph/ML history.

Replay rebuilds missing derived data from a committed journal snapshot and does
not acknowledge someone else's lease. The prototype CLI bounds replay to 10000
events; larger evaluation workloads need a cursor on a dedicated snapshot client.
Corrupt immutable copies are reported, not overwritten. A destructive full reset
requires an explicit administrative operation; integration tests demonstrate this
only inside their generated disposable database. Graceful stop finishes in-flight
work where possible; unprocessed claims become available after lease expiry.

HTTP approval returns 202 for a committed SQL transition with durable projection
work. That response does not claim projection delivery or signed-credential
publication. End-to-end tests must exercise concurrency, rollback, forbidden
scope, duplicate delivery, unavailable Mongo, stale leases and controlled rebuild.
