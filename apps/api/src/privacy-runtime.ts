import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, jwtVerify } from 'jose';
import type { PublicStatement } from '@academic-records/zk';
import {
  contextField,
  gradeCommitment,
  privateScalar,
  field,
  verifyEligibility,
} from '@academic-records/zk';
import type { EligibilityProof } from '@academic-records/zk';
import type { Sql } from './repository.js';
import { ApiFailure } from './errors.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const ZK_AUDIENCE = 'academic-records-eligibility-verifier-v1';
const issuer = 'urn:academic-records:local-issuer:zk-v1';
export const privacyFunctions = [
  'privacy.material(text,uuid)',
  'privacy.issue(text,uuid,uuid,numeric,numeric,text)',
  'privacy.read_owned(text,uuid)',
  'privacy.new_challenge(text,uuid,integer)',
  'privacy.read_challenge(uuid)',
  'privacy.consume(uuid)',
  'privacy.revoke(text,uuid,text)',
];
export class PrivacyService {
  readonly directory = resolve(root, '.runtime/zk-v1');
  readonly publicKey;
  readonly privateKey;
  readonly keyId: string;
  readonly manifest: {
    profile: string;
    setup: string;
    files: Record<string, string>;
    sourceHash: string;
  };
  readonly vk: unknown;
  constructor(readonly sql: Sql) {
    this.manifest = JSON.parse(
      readFileSync(resolve(this.directory, 'manifest.json'), 'utf8'),
    ) as PrivacyService['manifest'];
    if (
      this.manifest.profile !== 'academic-grade-threshold-v1' ||
      this.manifest.setup !== 'local-development-only' ||
      Object.keys(this.manifest.files).length !== 4
    )
      throw new Error('Invalid ZK artifact manifest');
    for (const [file, hash] of Object.entries(this.manifest.files)) {
      if (
        ![
          'grade_threshold.r1cs',
          'grade_threshold_js/grade_threshold.wasm',
          'grade_final.zkey',
          'verification_key.json',
        ].includes(file) ||
        createHash('sha256')
          .update(readFileSync(resolve(this.directory, file)))
          .digest('hex') !== hash
      )
        throw new Error('ZK artifact integrity failure');
    }
    if (
      createHash('sha256')
        .update(readFileSync(resolve(root, 'packages/zk/circuits/grade_threshold.circom')))
        .digest('hex') !== this.manifest.sourceHash
    )
      throw new Error('ZK source mismatch');
    this.vk = JSON.parse(
      readFileSync(resolve(this.directory, 'verification_key.json'), 'utf8'),
    ) as unknown;
    this.privateKey = createPrivateKey(
      readFileSync(resolve(root, '.runtime/zk-issuer/private.pem')),
    );
    this.publicKey = createPublicKey(readFileSync(resolve(root, '.runtime/zk-issuer/public.pem')));
    if (
      this.privateKey.asymmetricKeyType !== 'ed25519' ||
      !createPublicKey(this.privateKey)
        .export({ format: 'der', type: 'spki' })
        .equals(this.publicKey.export({ format: 'der', type: 'spki' }))
    )
      throw new Error('ZK issuer keys mismatch');
    this.keyId = createHash('sha256')
      .update(this.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex');
  }
  async call<T>(name: string, args: unknown[]): Promise<T> {
    const signatures: Record<string, string[]> = {
      material: ['text', 'uuid'],
      issue: ['text', 'uuid', 'uuid', 'numeric', 'numeric', 'text'],
      read_owned: ['text', 'uuid'],
      new_challenge: ['text', 'uuid', 'integer'],
      read_challenge: ['uuid'],
      consume: ['uuid'],
      revoke: ['text', 'uuid', 'text'],
    };
    const types = signatures[name];
    if (!types || types.length !== args.length) throw new Error('Invalid internal ZK call');
    return (
      await this.sql.query<{ value: T }>(
        `SELECT privacy.${name}(${types.map((v, i) => `$${i + 1}::${v}`).join(',')}) AS value`,
        args,
      )
    ).rows[0]!.value;
  }
  config() {
    return {
      profile: this.manifest.profile,
      setup: this.manifest.setup,
      audience: ZK_AUDIENCE,
      issuer,
      issuerKeyId: this.keyId,
      publicKey: this.publicKey.export({ format: 'jwk' }),
      verificationKey: this.vk,
      verificationKeyHash: this.manifest.files['verification_key.json'],
      wasmHash: this.manifest.files['grade_threshold_js/grade_threshold.wasm'],
      provingKeyHash: this.manifest.files['grade_final.zkey'],
    };
  }
  async readArtifact(artifact: string) {
    const result = await jwtVerify(artifact, this.publicKey, {
      algorithms: ['EdDSA'],
      issuer,
      typ: 'academic-eligibility+jwt',
    });
    if (
      result.protectedHeader.kid !== this.keyId ||
      result.payload.profile !== this.manifest.profile ||
      result.payload.vkHash !== this.manifest.files['verification_key.json']
    )
      throw new ApiFailure(400, 'INVALID_ISSUER_ARTIFACT', 'Credential artifact is not trusted');
    return result.payload as unknown as Attestation;
  }
  async issue(token: string, recordId: string, credentialId: string, holder: string) {
    field(holder);
    const previous = await this.call<PrivateCredential | null>('read_owned', [token, credentialId]);
    if (previous) {
      if (previous.recordId !== recordId || previous.holder !== holder)
        throw new ApiFailure(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Credential ID was used with different inputs',
        );
      return previous;
    }
    const material = await this.call<{
      requestId: string;
      recordId: string;
      versionNo: number;
      institutionId: string;
      grade: number;
      maximum: number;
    }>('material', [token, recordId]);
    const context = await contextField(
      'academic-grade-context-v1',
      JSON.stringify({
        credentialId,
        recordId,
        versionNo: material.versionNo,
        institutionId: material.institutionId,
        issuerKeyId: this.keyId,
      }),
    );
    const salt = privateScalar(),
      maximum = String(material.maximum),
      commitment = await gradeCommitment(String(material.grade), salt, context, holder, maximum);
    const artifact = await new SignJWT({
      profile: this.manifest.profile,
      credentialId,
      recordId,
      versionNo: material.versionNo,
      institutionId: material.institutionId,
      holder,
      context,
      commitment,
      maximum,
      vkHash: this.manifest.files['verification_key.json'],
    })
      .setProtectedHeader({ typ: 'academic-eligibility+jwt', alg: 'EdDSA', kid: this.keyId })
      .setIssuer(issuer)
      .setIssuedAt()
      .sign(this.privateKey);
    try {
      await this.call('issue', [token, credentialId, material.requestId, holder, salt, artifact]);
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === '23505') {
        const concurrent = await this.call<PrivateCredential | null>('read_owned', [
          token,
          credentialId,
        ]);
        if (concurrent?.recordId === recordId && concurrent.holder === holder) return concurrent;
      }
      throw error;
    }
    return this.call<PrivateCredential>('read_owned', [token, credentialId]);
  }
  async challenge(id: string): Promise<Challenge> {
    const q = await this.call<Omit<Challenge, 'statement'>>('read_challenge', [id]);
    const attestation = await this.readArtifact(q.artifact);
    if (
      attestation.credentialId !== q.credentialId ||
      attestation.recordId !== q.recordId ||
      attestation.versionNo !== q.versionNo
    )
      throw new ApiFailure(503, 'CREDENTIAL_INTEGRITY', 'Credential binding is inconsistent');
    const challenge = await contextField(
      'academic-grade-challenge-v1',
      JSON.stringify({
        audience: ZK_AUDIENCE,
        challengeId: q.challengeId,
        nonce: q.nonce,
        credentialId: q.credentialId,
        threshold: q.threshold,
        artifactDigest: createHash('sha256').update(q.artifact).digest('hex'),
      }),
    );
    return {
      ...q,
      statement: {
        commitment: attestation.commitment,
        context: attestation.context,
        holder: attestation.holder,
        maximum: attestation.maximum,
        threshold: q.threshold,
        challenge,
      },
    };
  }
  async verify(challengeId: string, bundle: EligibilityProof) {
    const q = await this.challenge(challengeId);
    if (q.used)
      throw new ApiFailure(409, 'CHALLENGE_USED', 'This challenge has already been consumed');
    if (Date.parse(q.expiresAt) <= Date.now())
      throw new ApiFailure(400, 'CHALLENGE_EXPIRED', 'Request a fresh challenge');
    if (!(await verifyEligibility(bundle, q.statement, this.vk)))
      throw new ApiFailure(400, 'INVALID_ZK_PROOF', 'Zero-knowledge proof verification failed');
    const status = await this.call<string>('consume', [challengeId]);
    if (status !== 'current')
      throw new ApiFailure(
        409,
        'CREDENTIAL_' + status.toUpperCase(),
        'The credential is ' + status,
      );
    const body = {
      profile: this.manifest.profile,
      challengeId,
      credentialId: q.credentialId,
      recordId: q.recordId,
      versionNo: q.versionNo,
      artifactDigest: createHash('sha256').update(q.artifact).digest('hex'),
      threshold: q.threshold,
      status: 'current',
      audience: ZK_AUDIENCE,
      nonce: q.nonce,
      nullifier: bundle.publicSignals[0]!,
      verifiedAt: new Date().toISOString(),
    };
    const receipt = await new SignJWT(body)
      .setProtectedHeader({ typ: 'academic-eligibility-result+jwt', alg: 'EdDSA', kid: this.keyId })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(this.privateKey);
    // SQL has already committed the single-use acceptance before a success is returned.
    return { ...body, receipt, exactGradeDisclosed: false };
  }
}
export interface PrivateCredential {
  credentialId: string;
  recordId: string;
  versionNo: number;
  artifact: string;
  salt: string;
  grade: string;
  maximum: string;
  holder: string;
  status: string;
}
interface Attestation {
  credentialId: string;
  institutionId: string;
  recordId: string;
  versionNo: number;
  commitment: string;
  context: string;
  holder: string;
  maximum: string;
}
export interface Challenge {
  challengeId: string;
  credentialId: string;
  artifact: string;
  threshold: string;
  nonce: string;
  expiresAt: string;
  recordId: string;
  versionNo: number;
  status: string;
  used: boolean;
  statement: PublicStatement;
}
