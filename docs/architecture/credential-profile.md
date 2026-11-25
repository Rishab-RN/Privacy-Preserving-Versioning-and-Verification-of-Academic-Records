# Academic credential disclosure profile v1

This Week 6 slice is a reusable, stateless SD-JWT cryptographic library. A deployed
SD-JWT issuance/status service and Ed25519 holder-key registration remain pending.
The separate [ZK course-grade profile](zero-knowledge-proofs.md) now implements its
own issuer artifact, approved-version SQL issuance/retrieval, holder-secret proof,
consent/challenge consumption, revocation and signed online acceptance. Migration
`0012` extends the existing log with that profile's credential events. The two
profiles are distinct: SD-JWT selective disclosure alone is not a ZK predicate.

## Wire profile

The profile uses RFC 9901 flat object-property disclosures, SHA-256 and public
Ed25519 holder keys in `cnf.jwk`. JOSE signing and verification use pinned
`jose@6.2.18`; application parsing rejects duplicate JSON members before semantic
processing. Input JSON need not be canonically serialized. Unsupported header or
claim members are rejected rather than ignored.

| Component               | Required form                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Issuer protected header | `alg=EdDSA`, `typ=academic-record+sd-jwt`, `kid=SHA256(SPKI DER)`                                                      |
| Always visible claims   | `iss`, integer `iat`/`exp`, `credentialId`, `logId`, `recordId`, positive integer `versionNo`, `cnf`, `_sd_alg`, `_sd` |
| Holder public JWK       | Exactly `kty=OKP`, `crv=Ed25519`, 32-byte canonical base64url `x`; private fields forbidden                            |
| Hidden claims           | Exactly six: `studentNumber`, `courseCode`, `courseTitle`, `credits`, `gradePoints`, `outcome`                         |
| Disclosure              | UTF-8 JSON `[salt,name,value]`, base64url encoded without padding; fresh 32-byte random salt per issued claim          |
| Commitments             | `_sd_alg=sha-256`, six distinct base64url digests, sorted independently of claim order                                 |
| Holder JWT header       | Exactly `alg=EdDSA`, `typ=kb+jwt`                                                                                      |
| Holder JWT payload      | Exactly `aud`, `nonce`, integer `iat`, `sd_hash`                                                                       |

`EdDSA` is pinned to Ed25519 key objects in this profile. Other curves, algorithm
identifiers, recursive/array disclosures, decoys and extensible claim sets are
unsupported. This is an application SD-JWT profile; it does not claim complete
SD-JWT VC or institutional credential-standard compliance.

Text claims are nonempty and bounded to 500 UTF-16 code units; credits are finite
numbers in `(0,100]`, grade points are a bounded decimal string or null, and outcome
uses the existing four-value enum. These are transport checks. SQL must still
enforce institutional grading bounds and approved record/version scope.

## Exact artifact and holder binding

Artifact **A** is the exact three-segment issuer compact JWS, ending before the
first `~`. Its SHA-256 hex digest stays identical across every selective
presentation. Disclosures are private holder material, not part of this artifact
digest. The issuer signature binds each hidden claim through its disclosure hash.
Hashing the full original issuance package would prevent a verifier from checking
the artifact without receiving all hidden claims.

The disclosure digest hashes ASCII bytes of its **encoded** base64url string,
without decoding/re-encoding it. The holder's `sd_hash` hashes ASCII bytes of
`A~selectedDisclosure1~...~`, including the final tilde. Reordering or re-encoding
disclosures invalidates the holder binding even when claim values look identical.
The holder helper verifies the pinned issuer, credential validity, all six private
disclosures and holder key match before returning a presentation.

Verification requires the exact consent set: missing, extra, duplicate and
unreferenced disclosures fail. It pins issuer and log keys independently, matches
expected issuer/credential/log/record/version/artifact digest, verifies holder
possession and compares the audience and nonce exactly. Holder proofs may be at
most 120 seconds old or five seconds ahead of trusted verifier time. Credentials
must not be expired and their issuance time must not be over five seconds ahead.
Input presentation size is bounded to 65,536 characters and JSON depth to 16.

`verifyLoggedPresentation` also verifies the sidecar inclusion proof and demands
`credential.issued` with matching credential ID, artifact digest, record/version
and holder key ID. This rejects an otherwise validly signed proof about another
credential. Key IDs follow the existing project SHA-256 SPKI convention; they are
not described as RFC 7638 JWK thumbprints.

## Remaining acceptance boundaries

This stateless library deliberately returns cryptographic evidence, not an
online current-status decision. Merkle inclusion is historical. A same nonce can
pass repeatedly unless the service atomically consumes it. The later SQL gate
must recheck authoritative current status while consuming a fresh server-issued
challenge, with scope, audience and consent bound to that challenge. Revoked,
superseded, expired, unavailable and authentic historical records must remain
distinct results. No revocation freshness is implied by this library result.

Opaque credential/record/log identifiers and holder keys are visible and linkable.
Selective disclosure limits claim exposure; it does not provide unlinkability,
anonymity, zero-knowledge predicates or secrecy for selected claims. The issuer
still sees the complete claims. Holder private keys must stay in the holder's
wallet/client, separate from issuer and log signing keys.

The tests use the RFC's fixed disclosure hash and independently constructed Node
Ed25519 JWTs, including noncanonical valid JSON. Negative cases cover duplicate
JSON names, malformed encoding, extra/private key members, type/algorithm
confusion, stale/wrong-holder proofs, altered disclosures and mismatched valid
Merkle evidence. Full third-party wallet interoperability and a security audit
are separate work.

Primary references: [RFC 9901, disclosure and key-binding formats](https://www.rfc-editor.org/rfc/rfc9901.html),
[RFC 8037, Ed25519 JOSE keys](https://www.rfc-editor.org/rfc/rfc8037.html),
and [JOSE implementation](https://github.com/panva/jose).
