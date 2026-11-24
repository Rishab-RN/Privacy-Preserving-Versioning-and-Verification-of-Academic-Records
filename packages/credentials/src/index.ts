import { createHash, createPublicKey, KeyObject, randomBytes } from 'node:crypto';
import { CompactSign, compactVerify } from 'jose';
import { canonicalBytes, checkpointKeyId, verifyEventProof } from '@academic-records/verification';
import type { EventProofBundle, KeyInput } from '@academic-records/verification';

export const CLAIM_NAMES = [
  'studentNumber',
  'courseCode',
  'courseTitle',
  'credits',
  'gradePoints',
  'outcome',
] as const;
export type ClaimName = (typeof CLAIM_NAMES)[number];
export type AcademicClaims = Record<ClaimName, string | number | null>;
export type HolderJwk = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
};
export interface CredentialIdentity {
  issuer: string;
  credentialId: string;
  logId: string;
  recordId: string;
  versionNo: number;
}
export interface IssuedCredential {
  artifact: string;
  disclosures: Record<ClaimName, string>;
}
export interface VerificationPolicy extends CredentialIdentity {
  issuerPublicKey: KeyObject;
  artifactDigest: string;
  audience: string;
  nonce: string;
  now: number;
  consentedClaims: readonly ClaimName[];
}
export class CredentialError extends Error {
  constructor() {
    super('Credential does not satisfy the academic disclosure profile');
    this.name = 'CredentialError';
  }
}
const fail = (): never => {
  throw new CredentialError();
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (text: string) => createHash('sha256').update(text, 'ascii').digest('base64url');
const encode = (value: unknown) => canonicalBytes(value).toString('base64url');
function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(value))
    return fail();
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value || (length !== undefined && result.length !== length))
    return fail();
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(value).length !== names.length || names.some((n) => !Object.hasOwn(value, n)))
    fail();
}
/** Accept JSON serialization order independently; reject duplicate names at every depth. */
function json(encoded: string): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes(encoded));
  const result: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
      if (stack.length > 16) fail();
    } else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key: string = JSON.parse(token);
      const names = stack.at(-1);
      if (!names || names.has(key)) return fail();
      names.add(key);
    }
  }
  // Also reject unsupported Unicode and exotic/non-JSON values with shared bounds.
  canonicalBytes(result);
  return result;
}
function seconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 253402300799
  )
    return fail();
  return value;
}
function text(value: unknown, maximum = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return fail();
  canonicalBytes(value);
  return value;
}
function identity(value: CredentialIdentity) {
  text(value.issuer, 2048);
  if (
    !uuid.test(value.credentialId) ||
    !uuid.test(value.logId) ||
    !uuid.test(value.recordId) ||
    !Number.isSafeInteger(value.versionNo) ||
    value.versionNo < 1 ||
    value.versionNo > 2147483647
  )
    fail();
}
function names(value: readonly ClaimName[]): ClaimName[] {
  if (
    !Array.isArray(value) ||
    value.length > 6 ||
    new Set(value).size !== value.length ||
    value.some((n) => !CLAIM_NAMES.includes(n))
  )
    return fail();
  return [...value].sort();
}
function claim(name: ClaimName, value: unknown): string | number | null {
  if (name === 'credits') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100)
      return fail();
    return value;
  }
  if (name === 'gradePoints') {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/.test(value)) return fail();
    return value;
  }
  if (
    name === 'outcome' &&
    !['passed', 'failed', 'withdrawn', 'incomplete'].includes(String(value))
  )
    return fail();
  return text(value);
}
export function holderPublicJwk(value: unknown): HolderJwk {
  const key = object(value);
  exact(key, ['kty', 'crv', 'x']);
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519') return fail();
  bytes(key.x, 32);
  const result: HolderJwk = { kty: 'OKP', crv: 'Ed25519', x: key.x as string };
  createPublicKey({ key: result, format: 'jwk' });
  return result;
}
export function publicJwk(key: KeyObject): HolderJwk {
  return holderPublicJwk(
    (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'jwk' }),
  );
}
export function holderKeyId(jwk: HolderJwk): string {
  return checkpointKeyId(createPublicKey({ key: holderPublicJwk(jwk), format: 'jwk' }));
}
function key(value: KeyObject, privateKey = false) {
  if (
    !(value instanceof KeyObject) ||
    value.asymmetricKeyType !== 'ed25519' ||
    value.type !== (privateKey ? 'private' : 'public')
  )
    fail();
  return value;
}
async function signJwt(payload: unknown, typ: string, privateKey: KeyObject, kid?: string) {
  return new CompactSign(canonicalBytes(payload))
    .setProtectedHeader({ alg: 'EdDSA', typ, ...(kid ? { kid } : {}) })
    .sign(key(privateKey, true));
}
async function verifyJwt(jwt: string, typ: string, publicKey: KeyObject, kid?: string) {
  const parts = jwt.split('.');
  if (parts.length !== 3 || jwt.length > 65536) return fail();
  parts.forEach((part) => bytes(part));
  bytes(parts[2], 64);
  const header = object(json(parts[0]!));
  exact(header, kid ? ['alg', 'typ', 'kid'] : ['alg', 'typ']);
  if (header.alg !== 'EdDSA' || header.typ !== typ || (kid && header.kid !== kid)) return fail();
  const payload = object(json(parts[1]!));
  await compactVerify(jwt, key(publicKey), { algorithms: ['EdDSA'] });
  return payload;
}
export function credentialArtifactDigest(artifact: string): string {
  if (typeof artifact !== 'string' || artifact.length > 65536 || artifact.split('.').length !== 3)
    return fail();
  artifact.split('.').forEach((part) => bytes(part));
  return createHash('sha256').update(artifact, 'ascii').digest('hex');
}
export function disclosureDigest(encoded: string): string {
  bytes(encoded);
  return hash(encoded);
}
export async function issueCredential(
  input: CredentialIdentity & {
    issuedAt: number;
    expiresAt: number;
    holderJwk: HolderJwk;
    claims: AcademicClaims;
  },
  issuerPrivateKey: KeyObject,
): Promise<IssuedCredential> {
  identity(input);
  seconds(input.issuedAt);
  seconds(input.expiresAt);
  if (input.expiresAt <= input.issuedAt) return fail();
  exact(object(input.claims), CLAIM_NAMES);
  const disclosures = {} as Record<ClaimName, string>;
  for (const name of CLAIM_NAMES)
    disclosures[name] = encode([
      randomBytes(32).toString('base64url'),
      name,
      claim(name, input.claims[name]),
    ]);
  const payload = {
    iss: input.issuer,
    iat: input.issuedAt,
    exp: input.expiresAt,
    credentialId: input.credentialId,
    logId: input.logId,
    recordId: input.recordId,
    versionNo: input.versionNo,
    cnf: { jwk: holderPublicJwk(input.holderJwk) },
    _sd_alg: 'sha-256',
    _sd: Object.values(disclosures).map(hash).sort(),
  };
  const artifact = await signJwt(
    payload,
    'academic-record+sd-jwt',
    issuerPrivateKey,
    checkpointKeyId(createPublicKey(issuerPrivateKey)),
  );
  return { artifact, disclosures };
}
function disclosure(encoded: string): { name: ClaimName; value: string | number | null } {
  const value = json(encoded);
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== 'string' ||
    bytes(value[0]).length < 16 ||
    !CLAIM_NAMES.includes(value[1] as ClaimName)
  )
    return fail();
  const name = value[1] as ClaimName;
  return { name, value: claim(name, value[2]) };
}
export interface IssuerTrust {
  issuer: string;
  issuerPublicKey: KeyObject;
  now: number;
}
async function trustedArtifact(artifact: string, trust: IssuerTrust) {
  const body = await verifyJwt(
    artifact,
    'academic-record+sd-jwt',
    trust.issuerPublicKey,
    checkpointKeyId(trust.issuerPublicKey),
  );
  exact(body, [
    'iss',
    'iat',
    'exp',
    'credentialId',
    'logId',
    'recordId',
    'versionNo',
    'cnf',
    '_sd_alg',
    '_sd',
  ]);
  if (
    body.iss !== trust.issuer ||
    body._sd_alg !== 'sha-256' ||
    seconds(body.iat) > trust.now + 5 ||
    seconds(body.exp) <= trust.now ||
    (body.exp as number) <= (body.iat as number)
  )
    return fail();
  const cnf = object(body.cnf);
  exact(cnf, ['jwk']);
  const holder = holderPublicJwk(cnf.jwk);
  if (!Array.isArray(body._sd) || body._sd.length !== 6 || new Set(body._sd).size !== 6)
    return fail();
  body._sd.forEach((d) => bytes(d, 32));
  identity({
    issuer: body.iss as string,
    credentialId: body.credentialId as string,
    logId: body.logId as string,
    recordId: body.recordId as string,
    versionNo: body.versionNo as number,
  });
  return { body, holder, digests: body._sd as string[] };
}
export async function createPresentation(
  issued: IssuedCredential,
  selectedClaims: readonly ClaimName[],
  binding: {
    audience: string;
    nonce: string;
    issuedAt: number;
    issuer: string;
    issuerPublicKey: KeyObject;
  },
  holderPrivateKey: KeyObject,
): Promise<string> {
  credentialArtifactDigest(issued.artifact);
  text(binding.audience, 2048);
  text(binding.nonce, 256);
  seconds(binding.issuedAt);
  const { holder, digests } = await trustedArtifact(issued.artifact, {
    ...binding,
    now: binding.issuedAt,
  });
  if (holderKeyId(holder) !== checkpointKeyId(createPublicKey(key(holderPrivateKey, true))))
    return fail();
  exact(object(issued.disclosures), CLAIM_NAMES);
  const decodedNames = new Set<string>();
  for (const encoded of Object.values(issued.disclosures)) {
    const value = disclosure(encoded);
    if (!digests.includes(hash(encoded)) || decodedNames.has(value.name)) return fail();
    decodedNames.add(value.name);
  }
  const selected = names(selectedClaims).map((name) => {
    const encoded = issued.disclosures[name];
    if (disclosure(encoded).name !== name) return fail();
    return encoded;
  });
  const sd = [issued.artifact, ...selected, ''].join('~');
  const kb = await signJwt(
    { aud: binding.audience, nonce: binding.nonce, iat: binding.issuedAt, sd_hash: hash(sd) },
    'kb+jwt',
    holderPrivateKey,
  );
  return sd + kb;
}
export async function verifyPresentation(presentation: string, policy: VerificationPolicy) {
  try {
    identity(policy);
    seconds(policy.now);
    text(policy.audience, 2048);
    text(policy.nonce, 256);
    const selected = names(policy.consentedClaims);
    if (typeof presentation !== 'string' || presentation.length > 65536) return fail();
    const parts = presentation.split('~');
    if (parts.length < 2 || parts.length > 8) return fail();
    const artifact = parts[0]!,
      kb = parts.at(-1)!;
    if (credentialArtifactDigest(artifact) !== policy.artifactDigest) return fail();
    const { body, holder, digests } = await trustedArtifact(artifact, policy);
    if (
      body.credentialId !== policy.credentialId ||
      body.logId !== policy.logId ||
      body.recordId !== policy.recordId ||
      body.versionNo !== policy.versionNo
    )
      return fail();
    const claims: Partial<AcademicClaims> = {};
    const seen = new Set<string>();
    for (const encoded of parts.slice(1, -1)) {
      const digest = hash(encoded);
      if (seen.has(digest) || !digests.includes(digest)) return fail();
      seen.add(digest);
      const value = disclosure(encoded);
      if (Object.hasOwn(claims, value.name)) return fail();
      claims[value.name] = value.value;
    }
    if (JSON.stringify(Object.keys(claims).sort()) !== JSON.stringify(selected)) return fail();
    const binding = await verifyJwt(kb, 'kb+jwt', createPublicKey({ key: holder, format: 'jwk' }));
    exact(binding, ['aud', 'nonce', 'iat', 'sd_hash']);
    const at = seconds(binding.iat);
    if (
      binding.aud !== policy.audience ||
      binding.nonce !== policy.nonce ||
      at > policy.now + 5 ||
      at < policy.now - 120 ||
      binding.sd_hash !== hash(parts.slice(0, -1).join('~') + '~')
    )
      return fail();
    return {
      identity: {
        issuer: policy.issuer,
        credentialId: policy.credentialId,
        logId: policy.logId,
        recordId: policy.recordId,
        versionNo: policy.versionNo,
      },
      artifactDigest: policy.artifactDigest,
      holderKeyId: holderKeyId(holder),
      claims,
    };
  } catch {
    return fail();
  }
}
/** Inclusion binds this exact issuer JWS, never the holder's varying disclosure set. */
export async function verifyLoggedPresentation(
  presentation: string,
  policy: VerificationPolicy,
  evidence: { proof: EventProofBundle; logPublicKey: KeyInput; issuanceEventId: string },
) {
  const result = await verifyPresentation(presentation, policy);
  if (
    !verifyEventProof(evidence.proof, evidence.logPublicKey, {
      logId: policy.logId,
      eventId: evidence.issuanceEventId,
    }).valid
  )
    return fail();
  const event = evidence.proof.entry.payload;
  if (
    event.kind !== 'credential.issued' ||
    event.credentialId !== policy.credentialId ||
    event.artifactDigest !== result.artifactDigest ||
    event.recordId !== policy.recordId ||
    event.versionNo !== policy.versionNo ||
    event.holderKeyId !== result.holderKeyId
  )
    return fail();
  return result;
}
