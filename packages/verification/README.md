# Independent verification library

`@academic-records/verification` runs on Node.js 24 without a database, API server,
network connection, runtime dependency or operational key file. Node's native
SHA-256 and Ed25519 implementations supply the cryptographic primitives.

## Event and checkpoint profile

`canonicalBytes(value)` implements the accepted JSON domain of
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html): ECMAScript primitive
serialization, recursive UTF-16 property sorting, preserved array order, UTF-8,
and no Unicode normalization. It rejects non-finite numbers, lone surrogates,
non-JSON values, accessors, custom object prototypes, sparse/decorated arrays and
cycles. Acyclic shared values are allowed. Limits are 1 MiB encoded JSON, depth 64
and 100,000 visited values. Large integers or exact decimal quantities belong in
strings; index/tree sizes must be nonnegative safe integers.

`parseCanonical(bytes)` requires exact canonical wire bytes. Parsing followed by
byte-for-byte recanonicalization rejects duplicate keys, alternate number/string
spellings, whitespace, a trailing newline, BOMs and invalid UTF-8. An already-parsed
object cannot establish whether its source once had duplicate keys.

An `EventEntry` is exactly:

```ts
{
  logId: string; // canonical lowercase UUID
  index: number; // zero-based committed position, safe integer
  salt: string; // 32 random bytes, 64 lowercase hexadecimal characters
  payload: {
    schemaVersion: 1;
    eventId: string; /* complete JSON event */
  }
}
```

`commitEvent(entry)` returns lowercase hexadecimal
`SHA256(UTF8("academic-records-event-v1\0") || canonicalBytes(entry))`. The caller
must generate a fresh cryptographically random salt and persist the complete
entry. Hashing includes every payload field; the verifier recomputes from those
fields instead of accepting a stored commitment column.

Merkle leaves contain the **32 decoded commitment bytes**. Following
[RFC 9162 §2.1](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1), the empty
root is `SHA256(empty)`, a leaf is `SHA256(0x00 || commitmentBytes)`, and a parent
is `SHA256(0x01 || leftHash || rightHash)`. Trees split at the largest power of two
strictly below their size. Odd trees are neither padded nor given a duplicated
last leaf. Proof paths contain lowercase SHA-256 hexadecimal strings.

`CheckpointBody` is exactly:

```ts
{
  profile: 'academic-records-log-v1';
  logId: string;
  treeSize: number;
  bootstrapSize: number; // immutable initial-import boundary, 0 <= boundary <= size
  rootHash: string; // 64 lowercase hexadecimal characters
  issuedAt: string; // exact Date.toISOString() UTC millisecond form
  keyId: string; // SHA256 of the trusted Ed25519 SPKI DER public key
}
```

`SignedCheckpoint` is `{ body, signature }`. The signature covers
`UTF8("academic-records-checkpoint-v1\0") || canonicalBytes(body)` using pure
Ed25519. It is 64 bytes encoded as unpadded canonical base64url. This is an
application checkpoint profile using RFC Merkle algorithms, **not CT wire-format
interoperability**. [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html) defines
Ed25519; [Node's crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptosignalgorithm-data-key-callback)
performs signing/verification with algorithm `null`. Key parameters accept an
Ed25519 `KeyObject` or PEM string/Buffer. A bundle-supplied key never establishes
trust: the caller supplies the trusted public key separately.

## Exported operations

| Operation                                                                       | Result                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `canonicalBytes(value)` / `parseCanonical(bytes)`                               | Buffer / parsed bounded JSON                        |
| `commitEvent(entry)`                                                            | SHA-256 hexadecimal commitment                      |
| `merkleRoot(commitments)`                                                       | Root for commitment bytes, including the empty tree |
| `inclusionProof(commitments, index)`                                            | Bottom-up sibling path                              |
| `verifyInclusion(commitment,index,size,path,root)`                              | Boolean                                             |
| `consistencyProof(commitments,oldSize)`                                         | Append-only prefix path                             |
| `verifyConsistency(oldSize,newSize,oldRoot,newRoot,path)`                       | Boolean                                             |
| `checkpointKeyId(publicKey)`                                                    | SHA-256 SPKI fingerprint                            |
| `signCheckpoint(body,privateKey)` / `verifyCheckpoint(signed,trustedPublicKey)` | Signed checkpoint / boolean                         |
| `compareCheckpoints(previous,next,path,trustedPublicKey)`                       | `{code}` observation result                         |
| `verifyEventProof(bundle,trustedPublicKey,{logId,eventId})`                     | `{valid,code}`                                      |

Generators reject malformed input by throwing; boolean verifiers return false.
Tree generation is bounded to 100,000 leaves and verification to 64 proof nodes.
Verification uses BigInt positions internally, avoiding JavaScript's 32-bit
bitwise truncation. Inclusion in an empty tree is invalid; singleton paths are
empty. An empty prefix is consistent with any authenticated later tree; equal
sizes require equal roots and an empty path. All proof nodes must be consumed.

`EventProofBundle` has `checkpoint`, complete `entry`, `inclusionProof`, and
optional `consistencyProof`. The expected log/event IDs are mandatory external
inputs. Signature, log/event binding and recomputed commitment inclusion must all
succeed. An optional consistency path is only an observation check when the
caller separately supplies an authenticated retained checkpoint.

Comparison returns `valid` for verified growth, `unchanged` for the same root and
size, `rollback` for a smaller signed size, `conflict` for two signed roots at the
same size, and `invalid` for other signature/log/bootstrap/time/proof failures.
Retain accepted checkpoints outside the mutable state being attacked. A first
valid observation alone cannot detect a consistent split view or old-root replay;
this package establishes historical integrity, not freshness, current grades,
factual correctness, independent witness control or key-compromise recovery.

## Offline CLI

```powershell
node packages/verification/dist/cli.js verify --bundle bundle.json --public-key trusted-public.pem --log-id LOG_UUID --event-id EVENT_UUID --previous retained-checkpoint.json
```

Omit `--previous` for inclusion/signature verification alone; output then says
`observation: "not-provided"`. With it, the standalone retained SignedCheckpoint
is compared against the new checkpoint using `bundle.consistencyProof`. A valid
inclusion does not override a rollback/conflict. File reads are bounded; the CLI
performs no network or database access and prints one JSON result. Exit status is
0 for valid, 1 for invalid, and 2 for usage/unavailable input.

Write bundle/checkpoint files using `canonicalBytes(value)` directly, without
pretty-printing or appending a newline. Disclosure bundles contain private event
data and salts; public roots/commitments do not require publishing those bundles.

## Validation

The tests include RFC 8785 serialization examples, RFC 8032's published Ed25519
vector, and hardcoded roots/paths calculated independently with Python hashlib
from the RFC 9162 definitions. They exhaust all leaves and prefix pairs for tree
sizes 0–65, cover odd/power-of-two boundaries, malformed/truncated/extended paths,
changed payload/salt/position, wrong signing keys, signed rollback/conflicting
roots, immutable bootstrap bounds and standalone offline CLI observations.
