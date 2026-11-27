import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import {
  canonicalBytes,
  checkpointKeyId,
  commitEvent,
  compareCheckpoints,
  consistencyProof,
  inclusionProof,
  merkleRoot,
  signCheckpoint,
  verifyEventProof,
} from '@academic-records/verification';
import type { EventEntry } from '@academic-records/verification';
import {
  closeProofRuntime,
  gradeCommitment,
  holderCommitment,
  proveEligibility,
  verifyEligibility,
} from '@academic-records/zk';

const sizes = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1000, 10000];
if (sizes.length > 5 || sizes.some((size) => !Number.isInteger(size) || size < 2 || size > 100000))
  throw new Error('Choose up to five integer journal sizes between 2 and 100000');
const samples = 20;
const warmups = 2;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function measure(task: () => unknown | Promise<unknown>) {
  for (let index = 0; index < warmups; index++) await task();
  const milliseconds: number[] = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    await task();
    milliseconds.push(performance.now() - start);
  }
  const sorted = milliseconds.toSorted((a, b) => a - b);
  return {
    p50Ms: sorted[Math.ceil(samples * 0.5) - 1],
    p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
    opsPerSecond: (samples * 1000) / milliseconds.reduce((sum, elapsed) => sum + elapsed, 0),
    milliseconds,
  };
}

const logId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const eventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const keys = generateKeyPairSync('ed25519');
async function merkle(size: number) {
  const entry: EventEntry = {
    logId,
    index: size - 1,
    salt: hash('verification-benchmark-fixture'),
    payload: { schemaVersion: 1, eventId, kind: 'grade.accepted' },
  };
  const leaves = Array.from({ length: size - 1 }, (_, index) =>
    hash(`benchmark-commitment-${index}`),
  );
  leaves.push(commitEvent(entry));
  const oldSize = Math.floor(size / 2);
  const header = {
    profile: 'academic-records-log-v1' as const,
    logId,
    bootstrapSize: 0,
    issuedAt: '2026-01-01T00:00:00.000Z',
    keyId: checkpointKeyId(keys.publicKey),
  };
  const sign = (treeSize: number, rootHash: string) =>
    signCheckpoint({ ...header, treeSize, rootHash }, keys.privateKey);
  const checkpoint = sign(size, merkleRoot(leaves));
  const previous = sign(oldSize, merkleRoot(leaves.slice(0, oldSize)));
  const path = consistencyProof(leaves, oldSize);
  const bundle = { checkpoint, entry, inclusionProof: inclusionProof(leaves, entry.index) };
  const signedProofBytes = canonicalBytes({ ...bundle, consistencyProof: path }).byteLength;
  return {
    size,
    canonicalInclusionBytes: canonicalBytes(bundle).byteLength,
    canonicalInclusionAndConsistencyBytes: signedProofBytes,
    inclusionNodes: bundle.inclusionProof.length,
    consistencyNodes: path.length,
    checkpointBuild: await measure(() => sign(size, merkleRoot(leaves))),
    inclusionBuild: await measure(() => inclusionProof(leaves, entry.index)),
    inclusionVerify: await measure(() =>
      assert(verifyEventProof(bundle, keys.publicKey, { logId, eventId }).valid),
    ),
    consistencyBuild: await measure(() => consistencyProof(leaves, oldSize)),
    consistencyVerify: await measure(() =>
      assert.equal(compareCheckpoints(previous, checkpoint, path, keys.publicKey).code, 'valid'),
    ),
  };
}

async function groth16() {
  const directory = '.runtime/zk-v1';
  const wasm = resolve(directory, 'grade_threshold_js/grade_threshold.wasm');
  const zkey = resolve(directory, 'grade_final.zkey');
  const verificationKey = resolve(directory, 'verification_key.json');
  const vkBytes = await readFile(verificationKey);
  const vk: unknown = JSON.parse(vkBytes.toString('utf8'));
  const witness = {
    grade: '850',
    salt: '93847199234578347821983748213749821374',
    secret: '8819847398221837498173274811324941824',
  };
  try {
    const holder = await holderCommitment(witness.secret);
    const statement = {
      commitment: await gradeCommitment(witness.grade, witness.salt, '1234', holder, '1000'),
      context: '1234',
      holder,
      maximum: '1000',
      threshold: '800',
      challenge: '987654321',
    };
    const prove = () => proveEligibility(statement, witness, { wasm, zkey });
    const bundle = await prove();
    assert.equal(await verifyEligibility(bundle, statement, vk), true);
    return {
      artifactSha256: {
        wasm: hash(await readFile(wasm)),
        zkey: hash(await readFile(zkey)),
        verificationKey: hash(vkBytes),
      },
      coreProofJsonBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
      prove: await measure(prove),
      verify: await measure(async () =>
        assert.equal(await verifyEligibility(bundle, statement, vk), true),
      ),
    };
  } finally {
    await closeProofRuntime();
  }
}

const git = (args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const rows = [];
for (const size of sizes) rows.push(await merkle(size));
const proof = await groth16();
const directory = '.runtime/benchmarks';
const generatedAt = new Date().toISOString();
const report = {
  profile: 'verification-components-v1',
  generatedAt,
  environment: {
    revision: git(['rev-parse', 'HEAD']),
    trackedChanges: git(['status', '--porcelain', '--untracked-files=no']).length > 0,
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpuCount: cpus().length,
    memoryBytes: totalmem(),
  },
  samples,
  warmups,
  merkle: rows,
  groth16: proof,
};
await mkdir(directory, { recursive: true });
const path = resolve(directory, 'verification-' + generatedAt.replaceAll(':', '-') + '.json');
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.info(
  JSON.stringify(
    {
      report: path,
      merkle: rows.map(({ size, inclusionVerify, canonicalInclusionBytes }) => ({
        size,
        verifyP50Ms: inclusionVerify.p50Ms,
        verifyP95Ms: inclusionVerify.p95Ms,
        canonicalInclusionBytes,
      })),
      groth16: {
        proveP50Ms: proof.prove.p50Ms,
        proveP95Ms: proof.prove.p95Ms,
        verifyP50Ms: proof.verify.p50Ms,
        verifyP95Ms: proof.verify.p95Ms,
        proofBytes: proof.coreProofJsonBytes,
      },
    },
    null,
    2,
  ),
);
