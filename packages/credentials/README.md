# Academic credential disclosure library

This private workspace implements the cryptographic portion of the Week 6
credential profile. It has no SQL, MongoDB, HTTP service, key provisioning or
wallet storage. Run `npm run build:credentials` and
`npm run test --workspace @academic-records/credentials` from the repository root.

The [profile](../../docs/architecture/credential-profile.md) specifies the exact
claims, encoding, trust inputs and acceptance boundaries. It implements flat
RFC 9901 disclosures with mandatory holder key binding. It does not claim complete
SD-JWT VC, OpenID4VC, W3C VC, recursive-disclosure or wallet interoperability.

| Export                                        | Responsibility                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `issueCredential`                             | Issue an exact compact issuer JWT plus six private disclosure strings using caller-supplied issuer and holder keys                    |
| `createPresentation`                          | Check the pinned issuer, validity, all supplied disclosures and matching holder key before signing only the selected claim set        |
| `verifyPresentation`                          | Check issuer, identity, exact artifact digest, disclosure commitments, exact consent, holder signature, audience, nonce and proof age |
| `verifyLoggedPresentation`                    | Additionally check pinned-key Merkle inclusion and bind the issuance event to that same artifact, holder and version                  |
| `credentialArtifactDigest`                    | SHA-256 hex of the exact compact issuer JWT, excluding disclosures and holder JWT                                                     |
| `disclosureDigest`                            | SHA-256 base64url of the encoded disclosure string                                                                                    |
| `publicJwk`, `holderPublicJwk`, `holderKeyId` | Export/validate public Ed25519 JWKs; calculate the project SPKI-based key identifier                                                  |

Issue once and persist the returned artifact and private disclosures unchanged.
Each issuance uses new salts, so reissuing in response to an idempotent retry is
incorrect. Issuance authorization, approved-version checks, exact retry semantics
and immutable persistence must be enforced by the later SQL/service layer.

Trusted verifier inputs include independently configured issuer/log public keys,
issuer identifier, expected credential/record/version, exact artifact digest,
expected audience/nonce, consent set and trusted current time in integer seconds.
Do not copy these expectations from an untrusted submitted presentation. The
sidecar proof's expected issuance event ID also comes from trusted context.

The holder helper requires all six disclosures privately, verifies them before
signing and returns only selected disclosures. The verifier receives no omitted
claim values. Errors from presentation verification are deliberately generic.

Library verification is stateless. It cannot consume a nonce or establish current
revocation/supersession status. The same valid proof can pass twice while within
its time window. Callers must atomically consume a server-issued challenge and
recheck current authoritative status before accepting an online transaction.

Tests include a published RFC digest, independently signed Node crypto fixtures,
noncanonical JSON serialization, hidden-claim omission, exact consent, malformed
encoding/JSON, signature/type/key confusion, freshness and validly signed but
unrelated log evidence. These establish the supported profile, not a security audit.
