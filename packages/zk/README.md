# Private grade threshold proofs

This workspace implements a real Groth16 proof over BN254 for an integer grade
predicate. A proof establishes knowledge of the grade, blinding salt and holder
secret opening an issuer commitment, with `threshold <= grade <= scheme maximum`.
Grade values use integer hundredths; no floating-point conversion or rounding is
accepted. A circuit-constrained nullifier binds the holder secret to the fresh
challenge and immutable credential context.

Run from the repository root:

```powershell
npm run zk:setup
npm run test:zk
```

Setup downloads the hash-pinned official iden3 Circom 2.2.3 Windows/Linux x64
compiler and compiles the reviewed source. A local Powers of Tau contribution and
circuit-specific contribution are verified with snarkjs. The manifest pins circuit
source, R1CS, WASM, proving key and verification key hashes. Repeat setup verifies
and preserves these files; mismatched/partial keys require review instead of silent
replacement. All generated artifacts stay under ignored `.runtime/zk-v1`.

**This is a single-operator local-development setup.** A verified transcript does
not prove that setup secrets were destroyed or contributors were independent.
Production/adversarial deployment requires an independently reviewed ceremony,
public artifact pinning and a circuit/application security review. Proofs are real;
these additional trust assumptions remain explicit in the UI and documentation.

Public signals, in compiled order:

| Index | Signal                                                       |
| ----- | ------------------------------------------------------------ |
| 0     | Holder/challenge/context nullifier                           |
| 1     | Issuer-bound Poseidon grade commitment                       |
| 2     | Credential/record/version/issuer context digest              |
| 3     | Holder-secret commitment                                     |
| 4     | Grading scheme maximum in hundredths                         |
| 5     | Consented threshold in hundredths                            |
| 6     | Audience/nonce/challenge/credential/threshold binding digest |

The circuit constrains the grade, threshold and maximum with 14-bit decomposition,
the maximum to 9999, and both salt and holder secret to 248 bits. Commitment and
holder/challenge domains are distinct fixed constants. The host additionally
requires canonical decimal scalar fields strictly below the BN254 scalar modulus,
a positive grading maximum and the exact public-signal order.

The verifier rejects a valid proof about the wrong commitment, threshold, holder,
context, grading maximum or challenge. A proof over a self-chosen commitment does
not establish an institution-issued grade: issuer signature, authoritative version
mapping, revocation/currentness and one-use consumption must be checked by the
service. No exact grade, salt or holder secret is contained in the public proof.
Public identifiers and predicate outcomes remain linkable; this is not anonymity.

Browser exports use the small Poseidon helper only for constructing the holder
commitment; proof soundness is checked by the compiled Circom circuit. That helper
uses JavaScript BigInt and is not constant-time or independently audited. Host
side-channel resistance is not claimed. Node uses circomlibjs for issuer commitments,
and real circuit tests establish matching hashes. Browser proof generation runs
in a worker; issuer and log signing keys are never included in frontend assets.

Tests generate real proofs and call raw witness generation for bad grades, salts
and holder secrets, independent of host prechecks. Modified public signals, proof
bytes, wrong keys, scalar aliases, challenge changes and exact threshold boundaries
are covered. Setup artifacts are not copied from the reference project.

Primary sources: [Circom compiler](https://github.com/iden3/circom),
[Circomlib constraints](https://github.com/iden3/circomlib),
[snarkjs setup and verification](https://github.com/iden3/snarkjs),
and [Groth16 paper](https://eprint.iacr.org/2016/260).
