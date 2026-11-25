# Zero-knowledge grade threshold profile v1

The implemented predicate is **knowledge of an issuer-attested course grade that
meets a consented minimum**. A verifier learns the threshold and whether it is
satisfied, without receiving the exact grade, blinding salt or holder secret.
This is a real Circom/Groth16 proof, separate from the
[SD-JWT disclosure library](credential-profile.md). It is not a GPA, full transcript,
anonymous identity or arbitrary institutional-policy proof.

## Statement and trust

Grades are exact integer hundredths: `8.50` becomes `850`. The host rejects
exponents, rounding, negative numbers and more than two decimal places. The circuit
constrains `threshold <= grade <= maximum <= 9999`, using 14-bit range checks;
the service additionally requires a positive scheme maximum. Salt and holder
secret are constrained to 248 bits. Canonical field strings are strictly below
the BN254 scalar modulus; modular aliases cannot bypass host checks.

| Value                             | Visibility and binding                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Grade, random salt, holder secret | Private circuit witness; never in the shareable proof                                                                                |
| Holder commitment                 | Poseidon of domain `2026112501` and secret                                                                                           |
| Grade commitment                  | Poseidon of domain `2026112502`, grade, salt, context, holder commitment and maximum                                                 |
| Context                           | Domain-separated SHA-256 truncated to 248 bits over credential/record/version/institution/issuer-key identity                        |
| Challenge                         | Separate SHA-256 domain over fixed verifier audience, challenge ID, nonce, credential ID, threshold and exact signed-artifact digest |
| Nullifier                         | Circuit output: Poseidon of domain `2026112503`, secret, challenge and context                                                       |

Public signals are ordered as nullifier, commitment, context, holder, maximum,
threshold, challenge. The verifier requires all seven, in that exact order.
Both changing an expected statement and changing a proof's public signals fail.

SQL provides the latest recorded independently approved passed numeric result;
seed/admin-only versions cannot be issued. The API computes the commitment from
that authoritative version, then signs an Ed25519 `academic-eligibility+jwt`.
It binds the credential ID, record/version, institution, holder/context/commitment,
maximum, profile and verification-key digest. The issuer key is separate from the
log signer and from the browser's holder secret. Issuance rechecks the selected
version under a record lock, so a concurrent approval cannot silently issue a
credential for a stale version. Exact and concurrent retries retain the first
committed artifact for the same credential ID, record and holder.

“Current” means **latest recorded approved version and not revoked**. It does not
mean the effective result at today's academic date: a future-effective correction
can already be the latest recorded version. This follows the existing bitemporal
model and is displayed as a versioned, as-of acceptance. Neither the proof nor the
issuer signature establishes that a university entered a factually correct grade.

## Holder and verifier flow

1. An authenticated student generates a secret in the browser and sends only its
   holder commitment. SQL checks ownership and institutional student role.
2. The owner receives a private wallet containing the issued artifact, grade,
   salt and local secret. It stays in component memory; an explicit private
   download supports restoration after navigation/reload. It is never a verifier
   input. The issuer necessarily knows the grade and salt.
3. The owner consents to a threshold. SQL creates an immutable random challenge
   and nonce. Expiry is computed as creation plus 120 seconds; the single local
   verifier audience is `academic-records-eligibility-verifier-v1`.
4. A browser Web Worker checks WASM/proving-key hashes and generates the proof
   locally. The shareable JSON contains only public context, the issuer artifact,
   public signals and proof. The worker is terminated after completion/error.
5. The public `/verify` workspace checks the actual proof and issuer signature.
   The API independently reconstructs the expected statement from SQL and its
   pinned artifact, verifies the proof and performs the authoritative status gate.
6. SQL locks the grade-record head, rechecks database-clock expiry and live
   revocation/supersession, and inserts a one-use challenge row. The unique key
   permits exactly one concurrent acceptance. An invalid proof does not consume
   consent. Revocation and approvals use the same record lock.
7. After consumption commits, the API signs a 60-second
   `academic-eligibility-result+jwt`. The UI checks its signature and binding to
   the challenge, credential/version, threshold and nullifier before showing success.

Acceptance is online and as-of. A receipt is historical evidence of that acceptance,
not a guarantee against later revocation. A response lost after consumption is
fail-closed: create a fresh challenge/proof rather than replaying a consumed one.
This prototype has one configured verifier audience; it does not implement
third-party verifier registration, independent verifier trust distribution or
cross-institutional federation. Shareable challenges expire; they are not permanent
offline eligibility certificates.

## SQL, BCNF and audit integration

Migration `0012` adds six immutable physical relations: credential, issuance event,
revocation, revocation event, challenge and challenge use. Record, tenant, student,
status, protocol constants and fixed expiry are reconstructed rather than copied
into dependent columns. See the complete [normal-form matrix](normalization.md).
API access is limited to seven security-definer RPC signatures; API, worker and
signer identities cannot read/write private base tables directly. Issuer API
compromise remains a trust boundary: SQL does not implement JWT/Poseidon verification.

Issuance and revocation atomically append positions and private salts to the same
institutional transparency log. Existing leaf bytes, ordering and checkpoints are
preserved. Public event payloads contain artifact digests and version/credential
references, without the private grade, holder secret or salt. The log operator
audits these actual SQL facts through a narrow reader. Credential events do not
enter the Mongo grade-projection queue. Publishing a checkpoint remains an explicit
separate operator action.

The verifier can check an issuance evidence file through
`POST /api/v1/zk/verify-history`. The API verifies the issuer artifact and binds
its exact SHA-256 digest, credential, record, version and institution to the
issuance event. It verifies the event path and checkpoint signature using the
locally provisioned log public key.

The issuance check establishes inclusion under the presented checkpoint and
reports its time and tree size. Currentness comes from the SQL acceptance
transaction. A successful history check can coexist with a revoked or superseded
credential, and works after the challenge expires. The operator compares the
prefix against a retained checkpoint before exporting. The offline CLI can
verify consistency with a verifier's own retained checkpoint.

## Setup and privacy limits

`npm run zk:setup` downloads the hash-pinned official Circom 2.2.3 Windows/Linux
x64 compiler, compiles the circuit, performs and verifies a local Powers of Tau
contribution and circuit-specific Groth16 contribution, then pins source, R1CS,
WASM, proving-key and verification-key hashes. Repeat setup validates and preserves
artifacts/issuer keys; it refuses partial or mismatched keys rather than rotating
them. Local artifacts, private issuer keys, wallets and reports remain ignored.

**The setup is single-operator local development.** Transcript verification does
not prove destruction of toxic waste or independent participation. Production or
adversarial use requires an independent reviewed ceremony, externally pinned
public artifacts/issuer trust, key management and a circuit/application audit.
Local manifest hashes detect accidental artifact drift; they do not protect
against an operator who controls the manifest and keys. Groth16 soundness also
depends on its cryptographic assumptions and the trusted setup.

Public credential/record/institution identifiers and the holder commitment are
linkable. Repeated threshold queries can narrow the grade; explicit holder consent
does not prevent a holder from intentionally disclosing it through many answers.
Revocation reasons are operator-visible audit material; avoid personal content.
The browser is trusted with its private witness. XSS, compromised devices, private
wallet theft, side channels and denial of service are not solved by ZK. The small
browser Poseidon helper uses non-constant-time JavaScript BigInt and is unaudited.
The API retains bounded bodies and request limits, but is a loopback lab service,
not a hardened public verification deployment.

## Evidence required before advancing

`npm run test:zk` generates real proofs and exercises raw circuit failures,
independently of host prechecks. It covers wrong witnesses, threshold boundaries,
altered public inputs/proof points, wrong keys, scalar aliases and changed challenges.
Integration tests cover restricted access, immutable BCNF storage, concurrent exact
issuance, one-winner acceptance, expiry, replay, revocation, supersession and signed
log integration. Browser tests generate proofs in the actual production worker,
check public payloads, use the unauthenticated verifier and registrar revocation
screen, and capture desktop/mobile output. Passing these checks supports this
prototype's stated behavior; it is not a formal security proof or an independent audit.

Primary references: [Groth16](https://eprint.iacr.org/2016/260),
[Circom](https://github.com/iden3/circom),
[comparators](https://github.com/iden3/circomlib/blob/master/circuits/comparators.circom),
[Poseidon constraints](https://github.com/iden3/circomlib/blob/master/circuits/poseidon.circom),
[snarkjs](https://github.com/iden3/snarkjs), and
[browser Poseidon helper](https://github.com/vimwitch/poseidon-lite).
