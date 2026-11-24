import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import test from 'node:test';
import {
  checkpointKeyId,
  commitEvent,
  merkleRoot,
  signCheckpoint,
} from '@academic-records/verification';
import type { EventProofBundle } from '@academic-records/verification';
import {
  CLAIM_NAMES,
  CredentialError,
  createPresentation,
  credentialArtifactDigest,
  disclosureDigest,
  holderKeyId,
  holderPublicJwk,
  issueCredential,
  publicJwk,
  verifyLoggedPresentation,
  verifyPresentation,
} from '../src/index.js';
import type { VerificationPolicy, ClaimName } from '../src/index.js';

const issuer = generateKeyPairSync('ed25519'),
  holder = generateKeyPairSync('ed25519');
const identity = {
  issuer: 'https://issuer.example',
  credentialId: randomUUID(),
  logId: randomUUID(),
  recordId: randomUUID(),
  versionNo: 2,
};
const now = 1806148800;
const claims = {
  studentNumber: 'PRIVATE_STUDENT_42',
  courseCode: 'CS362',
  courseTitle: 'Database systems',
  credits: 4,
  gradePoints: '8.00',
  outcome: 'passed',
};
const digest = (s: string) => createHash('sha256').update(s, 'ascii').digest('base64url');
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

test('RFC 9901 section 4.2.3 published disclosure digest matches exactly', () => {
  assert.equal(
    disclosureDigest('WyJfMjZiYzRMVC1hYzZxMktJNmNCVzVlcyIsICJmYW1pbHlfbmFtZSIsICJNw7ZiaXVzIl0'),
    'X9yH0Ajrdm1Oij4tWso9UzzKJvPoDxwmuEcO3XAdRC0',
  );
});
const decode = (s: string) =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
// Independent serialization/signing implementation for adversarial and interop fixtures.
function jws(
  payload: unknown,
  key: KeyObject,
  header: unknown = { alg: 'EdDSA', typ: 'kb+jwt' },
  raw?: string,
) {
  const input =
    enc(header) + '.' + (raw === undefined ? enc(payload) : Buffer.from(raw).toString('base64url'));
  return input + '.' + sign(null, Buffer.from(input, 'ascii'), key).toString('base64url');
}
async function fixture(selected: readonly ClaimName[] = ['courseCode', 'outcome']) {
  const issued = await issueCredential(
    {
      ...identity,
      issuedAt: now - 60,
      expiresAt: now + 3600,
      holderJwk: publicJwk(holder.publicKey),
      claims,
    },
    issuer.privateKey,
  );
  const binding = {
    issuer: identity.issuer,
    issuerPublicKey: issuer.publicKey,
    audience: 'https://verifier.example',
    nonce: 'random-verifier-nonce-value-32bytes',
    issuedAt: now,
  };
  const policy: VerificationPolicy = {
    ...identity,
    issuerPublicKey: issuer.publicKey,
    artifactDigest: credentialArtifactDigest(issued.artifact),
    audience: binding.audience,
    nonce: binding.nonce,
    now,
    consentedClaims: selected,
  };
  return {
    issued,
    binding,
    policy,
    presentation: await createPresentation(issued, selected, binding, holder.privateKey),
  };
}

test('consented claims alone are revealed; exact issuer artifact stays stable across presentations', async () => {
  const f = await fixture();
  const result = await verifyPresentation(f.presentation, f.policy);
  assert.deepEqual(result.claims, { courseCode: 'CS362', outcome: 'passed' });
  assert.equal(result.holderKeyId, holderKeyId(publicJwk(holder.publicKey)));
  assert(!f.presentation.includes(f.issued.disclosures.studentNumber));
  assert(!f.presentation.includes(f.issued.disclosures.gradePoints));
  const other = await createPresentation(f.issued, ['credits'], f.binding, holder.privateKey);
  assert.equal(other.split('~')[0], f.issued.artifact);
  assert.equal(credentialArtifactDigest(other.split('~')[0]!), f.policy.artifactDigest);
  assert.notEqual(f.presentation, other);
});

test('JOSE output verifies independently with Node Ed25519 and disclosure hashes use encoded strings', async () => {
  const f = await fixture();
  const [header, payload, signature] = f.issued.artifact.split('.') as [string, string, string];
  assert(
    verify(
      null,
      Buffer.from(header + '.' + payload),
      issuer.publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  );
  const decoded = decode(payload);
  for (const disclosure of Object.values(f.issued.disclosures))
    assert((decoded._sd as string[]).includes(digest(disclosure)));
  const kb = decode(f.presentation.split('~').at(-1)!.split('.')[1]!);
  assert.equal(kb.sd_hash, digest(f.presentation.slice(0, f.presentation.lastIndexOf('~') + 1)));
});

test('independently constructed, noncanonical JSON credentials and holder JWTs interoperate', async () => {
  const f = await fixture();
  const body = decode(f.issued.artifact.split('.')[1]!);
  const original = f.issued.disclosures.courseTitle;
  const replacement = Buffer.from(
    JSON.stringify(JSON.parse(Buffer.from(original, 'base64url').toString()), null, 2),
  ).toString('base64url');
  body._sd = (body._sd as string[]).map((d) => (d === digest(original) ? digest(replacement) : d));
  const artifact = jws(body, issuer.privateKey, {
    typ: 'academic-record+sd-jwt',
    kid: checkpointKeyId(issuer.publicKey),
    alg: 'EdDSA',
  });
  const sd = artifact + '~' + replacement + '~';
  const presentation =
    sd +
    jws(
      { nonce: f.binding.nonce, aud: f.binding.audience, sd_hash: digest(sd), iat: now },
      holder.privateKey,
    );
  const result = await verifyPresentation(presentation, {
    ...f.policy,
    artifactDigest: credentialArtifactDigest(artifact),
    consentedClaims: ['courseTitle'],
  });
  assert.deepEqual(result.claims, { courseTitle: 'Database systems' });
});

test('each issuance uses fresh salts without regenerating a persisted artifact on presentation', async () => {
  const a = await fixture(),
    b = await fixture();
  for (const name of CLAIM_NAMES)
    assert.notEqual(a.issued.disclosures[name], b.issued.disclosures[name]);
  const saved = structuredClone(a.issued);
  await createPresentation(a.issued, [], a.binding, holder.privateKey);
  assert.deepEqual(a.issued, saved);
});

test('exact consent rejects both missing and extra disclosures; empty consent is valid', async () => {
  const f = await fixture();
  for (const consent of [
    ['courseCode'],
    ['courseCode', 'outcome', 'credits'],
    ['courseCode', 'courseCode'],
  ] as ClaimName[][]) {
    await assert.rejects(
      verifyPresentation(f.presentation, { ...f.policy, consentedClaims: consent }),
      CredentialError,
    );
  }
  const empty = await fixture([]);
  assert.deepEqual((await verifyPresentation(empty.presentation, empty.policy)).claims, {});
});

test('audience, nonce, identity, pinned issuer and artifact digest substitution are rejected', async () => {
  const f = await fixture();
  for (const change of [
    { audience: 'https://evil.example' },
    { nonce: 'different-nonce' },
    { credentialId: randomUUID() },
    { logId: randomUUID() },
    { recordId: randomUUID() },
    { versionNo: 3 },
    { issuer: 'https://evil.example' },
    { artifactDigest: '0'.repeat(64) },
    { issuerPublicKey: holder.publicKey },
  ]) {
    await assert.rejects(
      verifyPresentation(f.presentation, { ...f.policy, ...change }),
      CredentialError,
    );
  }
});

test('missing, wrong-holder, stale and future key-binding proofs fail', async () => {
  const f = await fixture();
  await assert.rejects(
    verifyPresentation(f.presentation.slice(0, f.presentation.lastIndexOf('~') + 1), f.policy),
    CredentialError,
  );
  await assert.rejects(
    createPresentation(f.issued, ['courseCode'], f.binding, issuer.privateKey),
    CredentialError,
  );
  const sd = f.presentation.slice(0, f.presentation.lastIndexOf('~') + 1);
  for (const [key, time] of [
    [issuer.privateKey, now],
    [holder.privateKey, now - 121],
    [holder.privateKey, now + 6],
  ] as const) {
    const presentation =
      sd +
      jws({ aud: f.binding.audience, nonce: f.binding.nonce, iat: time, sd_hash: digest(sd) }, key);
    await assert.rejects(verifyPresentation(presentation, f.policy), CredentialError);
  }
  await assert.rejects(
    verifyPresentation(f.presentation, { ...f.policy, now: now + 3600 }),
    CredentialError,
  );
});

test('altered, duplicate, unreferenced or re-encoded disclosures cannot be presented', async () => {
  const f = await fixture();
  const parts = f.presentation.split('~');
  const course = parts[1]!;
  const unreferenced = enc(['A'.repeat(32), 'credits', 4]);
  const decoded = JSON.parse(Buffer.from(course, 'base64url').toString()) as unknown[];
  const recoded = Buffer.from(JSON.stringify(decoded, null, 2)).toString('base64url');
  for (const disclosures of [
    [course, course],
    [course, unreferenced],
    [recoded, parts[2]!],
    [enc(['A'.repeat(32), 'outcome', 'failed']), parts[2]!],
  ]) {
    const sd = [f.issued.artifact, ...disclosures, ''].join('~');
    const proof = jws(
      { aud: f.binding.audience, nonce: f.binding.nonce, iat: now, sd_hash: digest(sd) },
      holder.privateKey,
    );
    await assert.rejects(verifyPresentation(sd + proof, f.policy), CredentialError);
  }
});

test('holder signature binds disclosure order and the trailing tilde', async () => {
  const f = await fixture();
  const parts = f.presentation.split('~');
  await assert.rejects(
    verifyPresentation([parts[0], parts[2], parts[1], parts[3]].join('~'), f.policy),
    CredentialError,
  );
  const sd = parts.slice(0, -1).join('~') + '~';
  const bad =
    sd +
    jws(
      {
        aud: f.binding.audience,
        nonce: f.binding.nonce,
        iat: now,
        sd_hash: digest(sd.slice(0, -1)),
      },
      holder.privateKey,
    );
  await assert.rejects(verifyPresentation(bad, f.policy), CredentialError);
});

test('duplicate JWT members, type/algorithm confusion, private cnf and unsupported nested claims fail', async () => {
  const f = await fixture();
  const original = decode(f.issued.artifact.split('.')[1]!);
  const header = {
    alg: 'EdDSA',
    typ: 'academic-record+sd-jwt',
    kid: checkpointKeyId(issuer.publicKey),
  };
  const variants = [
    jws(
      original,
      issuer.privateKey,
      header,
      JSON.stringify(original).replace('"versionNo":2', '"versionNo":1,"versionNo":2'),
    ),
    jws(original, issuer.privateKey, { ...header, alg: 'none' }),
    jws(original, issuer.privateKey, { ...header, typ: 'kb+jwt' }),
    jws(original, issuer.privateKey, { ...header, crit: ['unknown'] }),
    jws(
      { ...original, cnf: { jwk: holder.privateKey.export({ format: 'jwk' }) } },
      issuer.privateKey,
      header,
    ),
    jws({ ...original, _sd_alg: 'sha-512' }, issuer.privateKey, header),
    jws({ ...original, extra: { _sd: [] } }, issuer.privateKey, header),
    jws(
      {
        ...original,
        _sd: [...(original._sd as string[]).slice(0, 5), (original._sd as string[])[0]],
      },
      issuer.privateKey,
      header,
    ),
  ];
  for (const artifact of variants) {
    const sd =
      artifact + '~' + f.issued.disclosures.courseCode + '~' + f.issued.disclosures.outcome + '~';
    const presentation =
      sd +
      jws(
        { aud: f.binding.audience, nonce: f.binding.nonce, iat: now, sd_hash: digest(sd) },
        holder.privateKey,
      );
    await assert.rejects(
      verifyPresentation(presentation, {
        ...f.policy,
        artifactDigest: credentialArtifactDigest(artifact),
      }),
      CredentialError,
    );
  }
});

test('malformed encodings, oversized input, wrong curves and private holder material fail', async () => {
  const f = await fixture();
  for (const input of ['', 'a'.repeat(65537), f.presentation.replace('.', '=.')])
    await assert.rejects(verifyPresentation(input, f.policy), CredentialError);
  assert.throws(
    () => holderPublicJwk(holder.privateKey.export({ format: 'jwk' })),
    CredentialError,
  );
  assert.throws(
    () => holderPublicJwk({ ...publicJwk(holder.publicKey), crv: 'X25519' }),
    CredentialError,
  );
  assert.throws(
    () => holderPublicJwk({ ...publicJwk(holder.publicKey), x: 'a=' }),
    CredentialError,
  );
});

test('log proof must bind the exact artifact, holder and immutable version', async () => {
  const f = await fixture();
  const log = generateKeyPairSync('ed25519');
  const eventId = randomUUID();
  const entry = {
    logId: identity.logId,
    index: 0,
    salt: 'ab'.repeat(32),
    payload: {
      schemaVersion: 1,
      eventId,
      institutionId: identity.logId,
      kind: 'credential.issued',
      credentialId: identity.credentialId,
      recordId: identity.recordId,
      versionNo: 2,
      artifactDigest: f.policy.artifactDigest,
      holderKeyId: holderKeyId(publicJwk(holder.publicKey)),
    },
  };
  const checkpoint = signCheckpoint(
    {
      profile: 'academic-records-log-v1',
      logId: identity.logId,
      treeSize: 1,
      bootstrapSize: 0,
      rootHash: merkleRoot([commitEvent(entry)]),
      issuedAt: new Date(now * 1000).toISOString(),
      keyId: checkpointKeyId(log.publicKey),
    },
    log.privateKey,
  );
  const proof: EventProofBundle = { entry, checkpoint, inclusionProof: [] };
  const evidence = { proof, logPublicKey: log.publicKey, issuanceEventId: eventId };
  assert.deepEqual((await verifyLoggedPresentation(f.presentation, f.policy, evidence)).claims, {
    courseCode: 'CS362',
    outcome: 'passed',
  });
  for (const change of [
    { artifactDigest: '0'.repeat(64) },
    { holderKeyId: '0'.repeat(64) },
    { versionNo: 1 },
    { credentialId: randomUUID() },
    { kind: 'request.submitted' },
  ]) {
    const wrong = structuredClone(proof);
    Object.assign(wrong.entry.payload, change);
    // Validly signed different fact must also fail the credential/proof binding.
    wrong.checkpoint = signCheckpoint(
      { ...checkpoint.body, rootHash: merkleRoot([commitEvent(wrong.entry)]) },
      log.privateKey,
    );
    await assert.rejects(
      verifyLoggedPresentation(f.presentation, f.policy, { ...evidence, proof: wrong }),
      CredentialError,
    );
  }
  await assert.rejects(
    verifyLoggedPresentation(f.presentation, f.policy, {
      ...evidence,
      logPublicKey: issuer.publicKey,
    }),
    CredentialError,
  );
});
