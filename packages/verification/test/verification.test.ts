import assert from 'node:assert/strict';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalBytes,
  parseCanonical,
  commitEvent,
  merkleRoot,
  inclusionProof,
  consistencyProof,
  verifyInclusion,
  verifyConsistency,
  checkpointKeyId,
  signCheckpoint,
  verifyCheckpoint,
  compareCheckpoints,
  verifyEventProof,
  EMPTY_ROOT,
  MAX_JSON_BYTES,
} from '../src/index.js';
import type {
  CheckpointBody,
  EventEntry,
  EventProofBundle,
  SignedCheckpoint,
} from '../src/index.js';
import { runCli } from '../src/cli.js';

const LOG = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
// RFC 8032 section 7.1, test 1. Public published test material, never operational keys.
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const privateKey = createPrivateKey({
  key: Buffer.from('302e020100300506032b657004220420' + SEED, 'hex'),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey({
  key: Buffer.from('302a300506032b6570032100' + PUBLIC, 'hex'),
  format: 'der',
  type: 'spki',
});
const hashes = Array.from({ length: 65 }, (_, index) =>
  index.toString(16).padStart(2, '0').repeat(32),
);

function event(index = 0): EventEntry {
  return {
    logId: LOG,
    index,
    salt: 'aa'.repeat(32),
    payload: { schemaVersion: 1, eventId: EVENT, gradePoints: '8.00' },
  };
}

function checkpoint(
  commitments: string[],
  overrides: Partial<CheckpointBody> = {},
): SignedCheckpoint {
  return signCheckpoint(
    {
      profile: 'academic-records-log-v1',
      logId: LOG,
      treeSize: commitments.length,
      bootstrapSize: 0,
      rootHash: merkleRoot(commitments),
      issuedAt: '2026-11-25T00:00:00.000Z',
      keyId: checkpointKeyId(publicKey),
      ...overrides,
    },
    privateKey,
  );
}

function bundle(): EventProofBundle {
  const entry = event();
  const commitments = [commitEvent(entry), ...hashes.slice(1, 7)];
  return {
    checkpoint: checkpoint(commitments),
    entry,
    inclusionProof: inclusionProof(commitments, 0),
  };
}

test('JCS uses ECMAScript numeric serialization, recursive UTF-16 sort and preserved array order', () => {
  assert.equal(
    canonicalBytes({ 2: 'two', 10: 'ten', 1: 'one', a: [{ z: 2, a: 1 }, 3] }).toString(),
    '{"1":"one","10":"ten","2":"two","a":[{"a":1,"z":2},3]}',
  );
  const numbers = [
    -0,
    0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    1e23,
    1e21,
    1e20,
    1e-6,
    1e-7,
    Number('333333333.33333329'),
  ];
  assert.equal(
    canonicalBytes(numbers).toString(),
    '[0,0,5e-324,-5e-324,1.7976931348623157e+308,1e+23,1e+21,100000000000000000000,0.000001,1e-7,333333333.3333333]',
  );
  const sorted = canonicalBytes({
    '\u20ac': 5,
    '\r': 1,
    '\ufb33': 7,
    '1': 2,
    '\ud83d\ude00': 6,
    '\u0080': 3,
    '\u00f6': 4,
  }).toString();
  assert.equal(sorted, '{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}');
  assert.notDeepEqual(canonicalBytes('é'), canonicalBytes('e\u0301'));
  assert.equal(canonicalBytes('\b\t\n\f\r"\\').toString(), '"\\b\\t\\n\\f\\r\\"\\\\"');
});

test('canonicalization rejects non-JSON values, accessors, cycles and malformed Unicode', () => {
  for (const input of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    () => 1,
    Symbol('x'),
    new Date(),
    new Map(),
    new Number(1),
    new Uint8Array([1]),
    '\ud800',
    { '\udc00': 1 },
    [undefined],
    { x: undefined },
    new Array(2),
  ]) {
    assert.throws(() => canonicalBytes(input));
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalBytes(cyclic));
  let called = false;
  assert.throws(() =>
    canonicalBytes({
      get x() {
        called = true;
        return 1;
      },
    }),
  );
  assert.equal(called, false);
  assert.throws(() => canonicalBytes(Object.defineProperty({}, 'hidden', { value: 1 })));
  assert.throws(() => canonicalBytes(Object.assign([1], { extra: true })));
  const shared = { value: 1 };
  assert.equal(canonicalBytes([shared, shared]).toString(), '[{"value":1},{"value":1}]');
});

test('canonical parsing rejects duplicate properties, alternate wire forms, invalid UTF-8 and excessive structure', () => {
  const safe = canonicalBytes({ '\u0000': 'a', nested: [true, null] });
  assert.deepEqual(canonicalBytes(parseCanonical(safe)), safe);
  for (const text of [
    '{"x":1,"x":2}',
    '{"x":{"a":1,"a":1}}',
    ' {"x":1}',
    '{"x":1}\n',
    '{"x":-0}',
    '{"x":1e0}',
    '{"z":1,"a":2}',
  ]) {
    assert.throws(() => parseCanonical(Buffer.from(text)));
  }
  assert.throws(() => parseCanonical(Buffer.from([0x22, 0xc3, 0x22])));
  assert.throws(() =>
    parseCanonical(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])),
  );
  assert.throws(() => canonicalBytes('x'.repeat(MAX_JSON_BYTES)));
  let nested: unknown = null;
  for (let index = 0; index < 64; index++) nested = { value: nested };
  assert.doesNotThrow(() => canonicalBytes(nested));
  assert.throws(() => canonicalBytes({ value: nested }));
  assert.throws(() => canonicalBytes(new Array(100_000).fill(null)));
});

test('event commitments match an independently calculated byte fixture and bind every entry field', () => {
  assert.equal(
    commitEvent(event()),
    '4ea3bba2bd9712d67b54232670c261e37940ec0936ac48e02b929b7303281101',
  );
  const original = commitEvent(event());
  for (const changed of [
    event(1),
    { ...event(), logId: OTHER },
    { ...event(), salt: 'ab'.repeat(32) },
    { ...event(), payload: { ...event().payload, gradePoints: '9.00' } },
  ]) {
    assert.notEqual(commitEvent(changed), original);
  }
  for (const invalid of [
    { ...event(), index: -1 },
    { ...event(), index: Number.MAX_SAFE_INTEGER + 1 },
    { ...event(), salt: 'AA'.repeat(32) },
    { ...event(), logId: 'not-a-uuid' },
    { ...event(), payload: { schemaVersion: 2, eventId: EVENT } },
    { ...event(), payload: { schemaVersion: 1 } },
    { ...event(), extra: true },
  ]) {
    assert.throws(() => commitEvent(invalid));
  }
});

test('RFC 9162 tree shape matches hardcoded SHA-256 vectors, including the seven-leaf right edge', () => {
  // Independently evaluated with Python hashlib from RFC 9162's recursive MTH;
  // entry i is exactly 32 repetitions of byte i, not text and not a leaf hash.
  const roots = [
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '7f9c9e31ac8256ca2f258583df262dbc7d6f68f2a03043d5c99a4ae5a7396ce9',
    '28fb81e496897e0ce886f08602392e9239b65c659041e5202163e58ad898f444',
    'ba8d94b7fbcecae7b81c4c80574fe24734a6917bf9c1ecd66ff3e0c34ead4620',
    'fdea52008cdae79fa8bf806261959e23f5e11681646a2fa2bc9b5e56b32030a2',
    '85e20cac1f02fda7bcdb2fc3f908568c57018c77815f1fa361acad13994f08bf',
    '380272ed524daf3398067faf4717782ba90805d4823ea6e1e594668c9fd40bba',
    '7318881c41fce3c1de3640df8e8c110c93f43f686b74204a9d1ad5b8c71c2047',
    'f907f23f76aa01b755a614d31ef9832909f44638b4590073301e61e6d01f9a1d',
  ];
  roots.forEach((root, size) => assert.equal(merkleRoot(hashes.slice(0, size)), root));
  assert.deepEqual(inclusionProof(hashes.slice(0, 7), 6), [
    'f1c176552a35e1d035f843d463220b6c85a90ea7f6644980630a6f71a3330ed3',
    roots[4],
  ]);
  assert.deepEqual(consistencyProof(hashes.slice(0, 7), 5), [
    '1da033bf8927ed69376d91533748494f7f5e88c20603dede2afc9bfd43d46f17',
    'f3ab555d06a67b08ab25039fdbe2a6fcb305c83bc165492ce81d3dea13ec1fbf',
    '511c6562982c9bfa05ba4145ca5f2bba85a11a178a4131b5cebde26dd9ffe704',
    roots[4],
  ]);
});

test('all leaves and prefix consistency proofs work for sizes zero through 65', () => {
  for (let size = 0; size <= hashes.length; size++) {
    const current = hashes.slice(0, size);
    const root = merkleRoot(current);
    for (let index = 0; index < size; index++) {
      assert.equal(
        verifyInclusion(current[index]!, index, size, inclusionProof(current, index), root),
        true,
        `inclusion ${index}/${size}`,
      );
    }
    for (let old = 0; old <= size; old++) {
      assert.equal(
        verifyConsistency(
          old,
          size,
          merkleRoot(current.slice(0, old)),
          root,
          consistencyProof(current, old),
        ),
        true,
        `consistency ${old}/${size}`,
      );
    }
  }
});

test('proof verification rejects truncated/extended/reordered/mutated paths, leaves and trees', () => {
  const current = hashes.slice(0, 7);
  const root = merkleRoot(current);
  const path = inclusionProof(current, 3);
  for (const bad of [
    path.slice(1),
    [...path, hashes[0]!],
    [...path].reverse(),
    [hashes[0]!, ...path.slice(1)],
  ]) {
    assert.equal(verifyInclusion(current[3]!, 3, 7, bad, root), false);
  }
  assert.equal(verifyInclusion(current[2]!, 3, 7, path, root), false);
  assert.equal(verifyInclusion(current[3]!, 2, 7, path, root), false);
  // Tree size must come from the signed checkpoint; siblings are opaque hashes.
  assert.equal(verifyInclusion(current[3]!, 3, 16, path, root), false);
  assert.notEqual(merkleRoot([...current].reverse()), root);
  assert.notEqual(merkleRoot(current.slice(1)), root);
  const oldRoot = merkleRoot(current.slice(0, 5));
  const proof = consistencyProof(current, 5);
  for (const bad of [
    [],
    proof.slice(1),
    [...proof, hashes[0]!],
    [...proof].reverse(),
    [hashes[0]!, ...proof.slice(1)],
  ]) {
    assert.equal(verifyConsistency(5, 7, oldRoot, root, bad), false);
  }
  assert.equal(verifyConsistency(5, 7, oldRoot, merkleRoot([...current].reverse()), proof), false);
});

test('proof bounds, empty/singleton/equal trees and safe integers beyond 32 bits are explicit', () => {
  assert.deepEqual(inclusionProof([hashes[0]!], 0), []);
  assert.equal(verifyInclusion(hashes[0]!, 0, 1, [], merkleRoot([hashes[0]!])), true);
  assert.equal(verifyInclusion(hashes[0]!, 0, 0, [], EMPTY_ROOT), false);
  assert.equal(verifyConsistency(0, 0, EMPTY_ROOT, EMPTY_ROOT, []), true);
  assert.equal(verifyConsistency(0, 0, hashes[0]!, EMPTY_ROOT, []), false);
  assert.equal(verifyConsistency(1, 1, hashes[0]!, hashes[1]!, []), false);
  assert.equal(verifyConsistency(7, 5, hashes[0]!, hashes[1]!, []), false);
  for (const invalid of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(verifyInclusion(hashes[0]!, invalid, 7, [], hashes[1]!), false);
    assert.equal(verifyConsistency(invalid, 7, hashes[0]!, hashes[1]!, []), false);
  }
  assert.equal(verifyInclusion(hashes[0]!, 2 ** 32, 2 ** 32 + 1, [], hashes[0]!), false);
  assert.equal(verifyInclusion(hashes[0]!, 0, 1, Array(65).fill(hashes[0]), hashes[0]!), false);
  assert.equal(verifyInclusion('ff', 0, 1, [], hashes[0]!), false);
  assert.equal(verifyConsistency(1, 1, hashes[10]!.toUpperCase(), hashes[10]!, []), false);
  assert.throws(() => inclusionProof([], 0));
  assert.throws(() => consistencyProof([], 1));
  assert.throws(() => merkleRoot(new Array(100_001).fill(hashes[0])));
});

test('large safe tree positions retain their high bits and proof accessors never execute', () => {
  const h = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
  const leaf = h(Buffer.concat([Buffer.from([0]), Buffer.from(hashes[0]!, 'hex')]));
  const path = hashes.slice(0, 33);
  const root = path
    .reduce(
      (left, sibling) => h(Buffer.concat([Buffer.from([1]), left, Buffer.from(sibling, 'hex')])),
      leaf,
    )
    .toString('hex');
  assert.equal(verifyInclusion(hashes[0]!, 0, 2 ** 32 + 1, path, root), true);
  const oldRoot = hashes[1]!;
  const newRoot = h(Buffer.concat([Buffer.from([1]), Buffer.from(oldRoot, 'hex'), leaf])).toString(
    'hex',
  );
  assert.equal(
    verifyConsistency(2 ** 32, 2 ** 32 + 1, oldRoot, newRoot, [leaf.toString('hex')]),
    true,
  );
  let called = false;
  const poisoned = Object.defineProperty([hashes[0]!], '0', {
    get() {
      called = true;
      return hashes[0]!;
    },
    enumerable: true,
  });
  assert.equal(verifyInclusion(hashes[0]!, 0, 2, poisoned, hashes[1]!), false);
  assert.throws(() => merkleRoot(poisoned));
  assert.equal(called, false);
});

test('native Ed25519 agrees with RFC 8032 test vector and application checkpoint bytes are independently checked', () => {
  assert.equal(
    sign(null, Buffer.alloc(0), privateKey).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );
  const signed = checkpoint(hashes.slice(0, 7));
  const independent = sign(
    null,
    Buffer.concat([Buffer.from('academic-records-checkpoint-v1\0'), canonicalBytes(signed.body)]),
    privateKey,
  ).toString('base64url');
  assert.equal(signed.signature, independent);
  assert.equal(verifyCheckpoint(signed, publicKey), true);
  assert.equal(verifyCheckpoint(signed, generateKeyPairSync('ed25519').publicKey), false);
  assert.equal(
    verifyCheckpoint({ ...signed, signature: signed.signature + '=' }, publicKey),
    false,
  );
  assert.equal(
    verifyCheckpoint({ ...signed, body: { ...signed.body, treeSize: 8 } }, publicKey),
    false,
  );
  assert.equal(
    verifyCheckpoint({ ...signed, body: { ...signed.body, bootstrapSize: 1 } }, publicKey),
    false,
  );
  for (const issuedAt of [
    '2026-11-25T00:00:00Z',
    '2026-11-25T00:00:00.000000Z',
    '2026-02-30T00:00:00.000Z',
    '2026-11-25T01:00:00.000+01:00',
  ]) {
    assert.throws(() => signCheckpoint({ ...signed.body, issuedAt }, privateKey));
  }
  assert.throws(() => signCheckpoint({ ...signed.body, bootstrapSize: 8 }, privateKey));
  assert.throws(() => signCheckpoint({ ...signed.body, keyId: hashes[0]! }, privateKey));
  assert.throws(() =>
    signCheckpoint(signed.body, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey),
  );
});

test('externally retained observations detect signed rollback and same-size conflicting roots', () => {
  const previous = checkpoint(hashes.slice(0, 5));
  const next = checkpoint(hashes.slice(0, 7), { issuedAt: '2026-11-25T00:01:00.000Z' });
  assert.deepEqual(
    compareCheckpoints(previous, next, consistencyProof(hashes.slice(0, 7), 5), publicKey),
    { code: 'valid' },
  );
  assert.deepEqual(compareCheckpoints(previous, previous, [], publicKey), { code: 'unchanged' });
  assert.deepEqual(compareCheckpoints(next, previous, [], publicKey), { code: 'rollback' });
  assert.deepEqual(
    compareCheckpoints(previous, checkpoint([...hashes.slice(0, 5)].reverse()), [], publicKey),
    { code: 'conflict' },
  );
  assert.deepEqual(compareCheckpoints(previous, next, [], publicKey), { code: 'invalid' });
  assert.deepEqual(
    compareCheckpoints(
      previous,
      checkpoint(hashes.slice(0, 7), { bootstrapSize: 2 }),
      [],
      publicKey,
    ),
    { code: 'invalid' },
  );
  assert.deepEqual(
    compareCheckpoints(previous, checkpoint(hashes.slice(0, 7), { logId: OTHER }), [], publicKey),
    { code: 'invalid' },
  );
});

test('event proof binds actual full payload bytes, pinned log/event and checkpoint signing key', () => {
  const original = bundle();
  assert.deepEqual(verifyEventProof(original, publicKey, { logId: LOG, eventId: EVENT }), {
    valid: true,
    code: 'valid',
  });
  assert.equal(
    verifyEventProof(original, publicKey, { logId: OTHER, eventId: EVENT }).code,
    'wrong-log',
  );
  assert.equal(
    verifyEventProof(original, publicKey, { logId: LOG, eventId: OTHER }).code,
    'wrong-event',
  );
  assert.equal(
    verifyEventProof(original, generateKeyPairSync('ed25519').publicKey, {
      logId: LOG,
      eventId: EVENT,
    }).code,
    'invalid-checkpoint',
  );
  const changed = structuredClone(original);
  changed.entry.payload.gradePoints = '9.00';
  assert.equal(
    verifyEventProof(changed, publicKey, { logId: LOG, eventId: EVENT }).code,
    'invalid-inclusion',
  );
  changed.entry = event(1);
  assert.equal(verifyEventProof(changed, publicKey, { logId: LOG, eventId: EVENT }).valid, false);
  assert.equal(
    verifyEventProof({ ...original, consistencyProof: [hashes[0]!] }, publicKey, {
      logId: LOG,
      eventId: EVENT,
    }).valid,
    true,
  );
  assert.equal(
    verifyEventProof({ ...original, consistencyProof: ['bad'] }, publicKey, {
      logId: LOG,
      eventId: EVENT,
    }).code,
    'invalid-format',
  );
});

test('offline CLI separates validity, retained observations, malformed input and unavailable/usage exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'academic-record-proof-'));
  const bundlePath = join(directory, 'bundle.json');
  const keyPath = join(directory, 'public.pem');
  const retainedPath = join(directory, 'retained.json');
  try {
    const proof = bundle();
    const commitments = [commitEvent(proof.entry), ...hashes.slice(1, 7)];
    const previous = checkpoint(commitments.slice(0, 3));
    proof.consistencyProof = consistencyProof(commitments, 3);
    await writeFile(bundlePath, canonicalBytes(proof));
    await writeFile(keyPath, publicKey.export({ type: 'spki', format: 'pem' }));
    await writeFile(retainedPath, canonicalBytes(previous));
    const args = [
      'verify',
      '--bundle',
      bundlePath,
      '--public-key',
      keyPath,
      '--log-id',
      LOG,
      '--event-id',
      EVENT,
    ];
    assert.equal((await runCli(args)).observation, 'not-provided');
    assert.deepEqual(await runCli([...args, '--previous', retainedPath]), {
      valid: true,
      code: 'valid',
      observation: 'valid',
      exitCode: 0,
    });
    await writeFile(retainedPath, canonicalBytes(checkpoint([...commitments, hashes[8]!])));
    assert.equal((await runCli([...args, '--previous', retainedPath])).code, 'rollback');
    await writeFile(bundlePath, JSON.stringify(proof, null, 2));
    assert.equal((await runCli(args)).exitCode, 1);
    await writeFile(bundlePath, Buffer.alloc(MAX_JSON_BYTES + 1));
    assert.equal((await runCli(args)).exitCode, 1);
    assert.equal((await runCli(['verify'])).exitCode, 2);
    assert.equal((await runCli([...args, '--unknown', 'value'])).code, 'usage');
    assert.equal(
      (
        await runCli([
          'verify',
          '--bundle',
          join(directory, 'missing'),
          '--public-key',
          keyPath,
          '--log-id',
          LOG,
          '--event-id',
          EVENT,
        ])
      ).code,
      'unavailable',
    );
  } finally {
    await Promise.all(
      [bundlePath, keyPath, retainedPath].map((path) => unlink(path).catch(() => {})),
    );
    await rmdir(directory);
  }
});
