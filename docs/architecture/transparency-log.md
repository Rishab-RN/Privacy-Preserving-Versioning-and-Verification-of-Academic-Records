# Signed academic event transparency

PostgreSQL remains the authority for grades and approval decisions. The
transparency log commits to retained workflow events; it does not approve a grade
or establish that an entered grade is factually correct. Its private SQL journal,
public commitments, signed checkpoints and independently retained observations
have different responsibilities.

## Event ordering and the bootstrap boundary

Forward migration `0011_event_sources.sql` introduces a unary event-identity
registry and the invoker-scoped `event_context` view. The log reader uses this
shared interface while source facts remain authoritative in workflow storage.
The event-position foreign key now targets the registry. A deferred foreign key
and source-membership trigger ensure each registered identity has its workflow
source; immutable guards prohibit registry reassignment or deletion. The append
function inserts identity and position in the same transaction.

This upgrade preserves all existing payload bytes, indices, salts, heads,
bootstrap boundaries and signed checkpoints. No old leaf is re-encoded. The
reader can distinguish source types without treating future credential events
as Mongo grade-projection work. Only workflow sources are currently accepted by
SQL; credential issuance, status and presentation endpoints remain subsequent
Week 6 work and need a forward subtype/permission migration.

Migration `0010_transparency_log.sql` adds one log per institution. An `AFTER
INSERT` trigger on `workflow.domain_event` derives the institution from the frozen
request, evidence reference and academic record. A separate `NOLOGIN` function
owner updates that institution's head and inserts an event position and random
32-byte salt in the same SQL transaction as the event.

The head update obtains a row lock held until the outer transaction ends. Another
transaction appending to the same institution waits. If the first transaction
commits, the waiting transaction obtains the next position; if it rolls back, its
event, salt and counter increment disappear and the position can be reused. No
uncommitted append becomes a visible gap. Multiple events in one transaction use
insertion order and become visible together. Institutions have independent heads;
this is not a global order across institutions. Administrative batches spanning
institutions should lock in sorted institutional order or retry deadlocks.

UUIDs identify events. Event timestamps describe recorded event times. Neither a
UUID, timestamp nor sequence alone establishes commit order. PostgreSQL retains
row locks until transaction end, which is the ordering mechanism used here.
[PostgreSQL row locking](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)

Before this migration, original commit order was not recorded. The migration
blocks journal writes, preserves every existing event and assigns an import order
using `(occurred_at, event_id)` within each institution. `bootstrap_size` freezes
the imported prefix length. These entries must be described as **migration import
order; original commit order unknown**. Later positions are transactionally
sequenced. Existing seed-only grade versions do not acquire invented workflow
events or a claim of historical log coverage.

Every signed checkpoint binds the bootstrap boundary. Checkpoint persistence
rejects a size smaller than that boundary. Repeating migrations leaves positions,
salts and the bootstrap boundary unchanged.

## Physical relations and BCNF

| Relation                      | Physical attributes                                                            | Candidate keys and dependencies                                            |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `transparency.log_state`      | `institution_id`, `tree_size`, `bootstrap_size`                                | `institution_id` determines the counter and immutable import boundary.     |
| `transparency.event_position` | `event_id`, `institution_id`, `leaf_index`, `salt`                             | `event_id` and `(institution_id, leaf_index)` each determine the full row. |
| `transparency.checkpoint`     | `institution_id`, `tree_size`, `root_hash`, `issued_at`, `key_id`, `signature` | `(institution_id, tree_size)` determines the signed evidence.              |

Every identified nontrivial scalar dependency has a candidate-key determinant.
The three new physical relations therefore satisfy BCNF under these dependencies.
Cryptographic collisions are not ruled out by treating roots, signatures or salts
as relational keys. Random salts are not assumed to be unique. Operator key IDs
may authorize multiple institutional logs, so a key ID does not determine an
institution. A future institution-specific key registry must separate keys from
institution/key authorizations rather than copy public keys into checkpoints.

Protocol and algorithm identifiers are constants of the versioned verification
profile rather than repeated SQL columns. Checkpoint `bootstrapSize` comes from
the immutable log state; the checkpoint table does not store that copy. Event
payloads remain in the existing journal. Commitments and canonical payload bytes
are computed, not redundantly persisted in another physical table.

Sizes fit JavaScript's exact integer range, from zero through 9,007,199,254,740,991.
Positions are zero based and smaller than the corresponding head size. SQL
constraints also enforce foreign keys, alternate position uniqueness, salt/root
lengths of 32 bytes, signatures of 64 bytes and lowercase 64-character key IDs.
Positions and checkpoints cannot be updated or deleted through ordinary SQL
transitions. Head updates advance exactly once and cannot change the institution
or bootstrap boundary.

## Commitments, proofs and confidentiality

The shared verification package owns the pinned event encoding, salted commitment,
Merkle tree and signed checkpoint profile. Canonicalization must preserve the
event's decimal grade strings and microsecond timestamp strings. PostgreSQL's
`jsonb::text` is not an RFC 8785 canonicalizer. The existing Mongo projection replay
fingerprint is not externally trusted signature evidence.
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)

The Merkle implementation uses separate leaf and internal-node hash domains, an
explicit empty-tree root and the largest-power-of-two split for an uneven tree.
Inclusion paths bind the position and tree size. Consistency proofs establish
that a later accepted tree extends an earlier accepted prefix. Odd leaves are not
duplicated to pad a tree. These tree conventions follow the RFC 9162 construction;
this project does not claim to implement the Certificate Transparency protocol.
[RFC 9162, section 2.1](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1)

Payloads can contain grades, reasons, actor IDs and evidence digests. They and their
salts remain private. A public commitment without its independent random salt
reduces guessing of low-entropy grade values; publishing raw payload hashes or
salts would defeat that boundary. An authorized private proof may include the
payload and salt needed to recompute its commitment. Public proof material must
exclude those values, student data and private signing keys. Log identity, size
and observation timing can still reveal activity metadata.

A full audit recomputes commitments from actual retained payloads and salts,
rebuilds the root and compares it with authenticated expected evidence. Trusting
only saved hash columns would not establish payload integrity. The audit also
compares each journal payload with independently reconstructed authoritative SQL
facts and reports grade versions without an accepted workflow event separately.

## Authoritative reconstruction

`transparency.read_expected_event(event_id uuid) RETURNS jsonb` is a private,
read-only, invoker-rights function. It returns SQL `NULL` for an unknown ID. For a
known event it constructs the complete original envelope from its scalar journal
identity/time, request, evidence reference, decision and grade version rather than
copying the journal's JSON payload.

For `request.submitted`, the actor remains the proposer and both decision and
revision remain JSON `null` forever, including after a later approval or rejection.
For `grade.accepted`, the actor and result come from the approved decision and
referenced immutable grade version. For `request.rejected`, the actor comes from
the rejecting decision and no revision is emitted. Inconsistent decision/event
bindings fail. This reconstruction detects disagreement between source facts and
the retained envelope; signed-root comparison additionally detects coordinated
changes to both when trusted expected evidence is available.

## Signing and checkpoint persistence

The signer is an administrative process, separate from the API and Mongo worker.
It reads the institutional head, positions, salts and payloads from one
`REPEATABLE READ READ ONLY` snapshot on a separate connection and requires exactly
the prefix `0..N-1`. It commits that read transaction before hashing and signing.
An event seen only inside its own uncommitted workflow transaction must never be
signed. A concurrent append after the read does not invalidate the committed
prefix being signed.

Private Ed25519 keys belong in ignored local files outside public artifacts, with
access restricted to the operator. Database rows, API configuration and worker
configuration do not contain the private key. Verification pins the permitted
log identity and public key through trusted configuration; a public key supplied
inside an untrusted proof does not establish trust.

The persistence function has the exact signature:

```sql
transparency.record_checkpoint(
  institution_id uuid,
  tree_size bigint,
  root_hash bytea,
  issued_at timestamptz,
  key_id text,
  signature bytea
) RETURNS transparency.checkpoint
```

It checks argument shape, institutional existence, size against the available
head/import boundary and the presence of every requested position. It serializes
checkpoint insertion using the institutional head lock. An exact retry returns
the original row. Different root, time, key or signature at the same size raises a
conflict and never overwrites previously stored evidence.

`issued_at` is stored as `timestamptz(3)`. Inputs with submillisecond precision are
rejected before PostgreSQL could round signed data. Checkpoint JSON reconstructs
the time using exactly three millisecond digits:

```sql
to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
```

This SQL function is a trusted persistence boundary. It does **not** verify an
Ed25519 signature, derive a root or determine whether the signer used a committed
snapshot. The restricted signer and shared independent verifier perform those
checks. The signer persists in a separate write transaction and exports or returns
the artifact only after successful commit. A failed write does not become a
reported publication. An exact stored checkpoint is reused after a process retry.

## Database privileges

| Identity              | Permitted responsibilities                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `academic_log_owner`  | Nonlogin function owner with the scoped reads and head/position/checkpoint writes needed by controlled functions. No application role inherits it.                                |
| `academic_log_reader` | Read the private transparency journal and necessary workflow, evidence and academic facts; reconstruct expected events. No access-control schema, credentials or write authority. |
| `academic_log_signer` | Inherits the reader; additionally calls `record_checkpoint`. No direct insert/update/delete on transparency or academic tables.                                                   |
| API and Mongo worker  | Keep existing workflow/projection authority. No raw transparency tables, salts, checkpoint writes or signing keys.                                                                |

New functions use fixed search paths and qualified references. The salt helper
resolves and calls the actual installed `pgcrypto.gen_random_bytes` function in
its qualified extension namespace. Public execution and schema/table access are
revoked; only the declared administrative read/persistence functions are granted.
[PostgreSQL random-data functions](https://www.postgresql.org/docs/18/pgcrypto.html#PGCRYPTO-RANDOM-DATA-FUNCS)

## Verification and limits

The SQL suite covers minimal keys and columns, role boundaries, concurrent commit
and rollback ordering, independent institutions, atomic proposal/approval rollback,
authoritative event reconstruction, controlled payload corruption, empty and
historical prefixes, exact checkpoint retries, conflicting evidence, malformed
inputs, precision, missing positions and a populated forward migration.

Cryptographic tests separately cover canonical bytes, changed payloads/salts,
invalid signatures, altered proof paths, empty/odd trees, repeated appends,
consistency, deletion/reordering and conflicting retained checkpoints. SQL shape
tests may use arbitrary signature bytes to test the persistence boundary; those
bytes are not a claim of valid cryptographic evidence.

Detection of rollback, deletion or split views depends on retaining authenticated
expected checkpoints and comparing observations. A same-machine artifact is not
an independently controlled witness. An unsigned new event remains outside the
last accepted signed prefix. A valid older prefix proves historical integrity;
it does not by itself prove freshness or that no later correction exists. SQL
owners and superusers remain privileged; independent retained evidence is needed
to detect their coordinated changes. No ML anomaly score can override a failed
cryptographic check.
