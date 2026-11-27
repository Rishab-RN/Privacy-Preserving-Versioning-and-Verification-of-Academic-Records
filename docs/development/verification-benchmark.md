# Verification component benchmark

Run from the repository root with Node.js 24 and the local development
circuit artifacts. If needed, prepare them with `npm run zk:setup`.

```powershell
npm run benchmark:verification
npm run benchmark:verification -- 1000 10000 100000
```

The default run covers 1,000 and 10,000 synthetic journal commitments. For
each size it measures checkpoint construction and signing, last-leaf inclusion
proof construction and verification, and consistency proof construction and
comparison against a retained half-size checkpoint. It measures warm sequential
Groth16 grade-threshold proving and verification against the installed circuit.
The proof benchmark runs in Node.js and clocks the core proof and public signals.
Browser startup, the signed issuer artifact, API traffic, database calls, setup
and journal serialization are outside these component measurements.

The command writes a timestamped JSON file under ignored `.runtime/benchmarks/`.
Each operation has two warm-ups and twenty timed samples. The report contains
all samples, nearest-rank p50 and p95, sequential operations per second,
canonical proof sizes, circuit artifact hashes and the host/runtime configuration.
Use a clean checkout and compare multiple runs on the same hardware to assess
variation. Synthetic Merkle entries contain no student data. The sizes describe
commitments in memory and cannot be interpreted as database storage.

Week 11 also needs end-to-end timings and recovery measurements. The
[provenance benchmark](provenance-demo.md) and [anomaly evaluation](anomaly-demo.md)
have separate workload definitions.
