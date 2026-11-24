import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { canonicalBytes } from './canonical.js';
import type { JsonValue } from './canonical.js';
import {
  decodeHash,
  digest,
  validSize,
  verifyConsistency,
  verifyInclusion,
  EMPTY_ROOT,
} from './merkle.js';

export { canonicalBytes, parseCanonical, MAX_JSON_BYTES, MAX_JSON_DEPTH } from './canonical.js';
export type { JsonValue } from './canonical.js';
export {
  merkleRoot,
  inclusionProof,
  consistencyProof,
  verifyInclusion,
  verifyConsistency,
  EMPTY_ROOT,
  MAX_TREE_LEAVES,
  MAX_PROOF_NODES,
} from './merkle.js';

export type KeyInput = KeyObject | string | Buffer;
export interface EventEntry {
  logId: string;
  index: number;
  salt: string;
  payload: { [key: string]: JsonValue };
}
export type PrivateEventEntry = EventEntry;
export interface CheckpointBody {
  profile: 'academic-records-log-v1';
  logId: string;
  treeSize: number;
  bootstrapSize: number;
  rootHash: string;
  issuedAt: string;
  keyId: string;
}
export interface SignedCheckpoint {
  body: CheckpointBody;
  signature: string;
}
export interface EventProofBundle {
  checkpoint: SignedCheckpoint;
  entry: EventEntry;
  inclusionProof: string[];
  consistencyProof?: string[];
}
export type ComparisonCode = 'valid' | 'unchanged' | 'rollback' | 'conflict' | 'invalid';
export type ProofCode =
  | 'valid'
  | 'invalid-format'
  | 'invalid-checkpoint'
  | 'wrong-log'
  | 'wrong-event'
  | 'invalid-inclusion';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EVENT_DOMAIN = Buffer.from('academic-records-event-v1\0', 'ascii');
const CHECKPOINT_DOMAIN = Buffer.from('academic-records-checkpoint-v1\0', 'ascii');

function ordinary(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Expected plain object');
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  canonicalBytes(value);
  ordinary(value);
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('Unexpected object fields');
  }
}

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new Error('Expected canonical lowercase UUID');
}

function entry(value: unknown): asserts value is EventEntry {
  exact(value, ['logId', 'index', 'salt', 'payload']);
  uuid(value.logId);
  validSize(value.index);
  decodeHash(value.salt);
  ordinary(value.payload);
  if (!Object.hasOwn(value.payload, 'schemaVersion') || value.payload.schemaVersion !== 1)
    throw new Error('Unsupported event schema');
  if (!Object.hasOwn(value.payload, 'eventId')) throw new Error('Missing event identity');
  uuid(value.payload.eventId);
}

export function commitEvent(value: EventEntry): string {
  entry(value);
  return digest(Buffer.concat([EVENT_DOMAIN, canonicalBytes(value)])).toString('hex');
}

function publicKey(key: KeyInput): KeyObject {
  const result = key instanceof KeyObject ? key : createPublicKey(key);
  if (result.type !== 'public' || result.asymmetricKeyType !== 'ed25519') {
    throw new Error('Expected Ed25519 public key');
  }
  return result;
}

export function checkpointKeyId(key: KeyInput): string {
  return digest(publicKey(key).export({ type: 'spki', format: 'der' })).toString('hex');
}

function body(value: unknown): asserts value is CheckpointBody {
  exact(value, ['profile', 'logId', 'treeSize', 'bootstrapSize', 'rootHash', 'issuedAt', 'keyId']);
  if (value.profile !== 'academic-records-log-v1')
    throw new Error('Unsupported checkpoint profile');
  uuid(value.logId);
  validSize(value.treeSize);
  validSize(value.bootstrapSize);
  if (value.bootstrapSize > value.treeSize) throw new Error('Bootstrap boundary exceeds tree size');
  decodeHash(value.rootHash);
  decodeHash(value.keyId);
  if (value.treeSize === 0 && value.rootHash !== EMPTY_ROOT) throw new Error('Invalid empty root');
  if (
    typeof value.issuedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.issuedAt)
  ) {
    throw new Error('Expected canonical UTC millisecond timestamp');
  }
  const date = new Date(value.issuedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.issuedAt) {
    throw new Error('Invalid checkpoint timestamp');
  }
}

function checkpoint(value: unknown): asserts value is SignedCheckpoint {
  exact(value, ['body', 'signature']);
  body(value.body);
  if (typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) {
    throw new Error('Expected unpadded Ed25519 signature');
  }
  const decoded = Buffer.from(value.signature, 'base64url');
  if (decoded.length !== 64 || decoded.toString('base64url') !== value.signature) {
    throw new Error('Noncanonical signature encoding');
  }
}

function signedBytes(value: CheckpointBody): Buffer {
  return Buffer.concat([CHECKPOINT_DOMAIN, canonicalBytes(value)]);
}

export function signCheckpoint(value: CheckpointBody, key: KeyInput): SignedCheckpoint {
  body(value);
  const privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Expected Ed25519 private key');
  }
  if (value.keyId !== checkpointKeyId(createPublicKey(privateKey)))
    throw new Error('Checkpoint key ID mismatch');
  const copied = JSON.parse(canonicalBytes(value).toString('utf8')) as CheckpointBody;
  return {
    body: copied,
    signature: sign(null, signedBytes(copied), privateKey).toString('base64url'),
  };
}

export function verifyCheckpoint(value: SignedCheckpoint, trustedPublicKey: KeyInput): boolean {
  try {
    checkpoint(value);
    const trusted = publicKey(trustedPublicKey);
    return (
      value.body.keyId === checkpointKeyId(trusted) &&
      verify(null, signedBytes(value.body), trusted, Buffer.from(value.signature, 'base64url'))
    );
  } catch {
    return false;
  }
}

/** Caller retains accepted checkpoints independently of attacked mutable state. */
export function compareCheckpoints(
  previous: SignedCheckpoint,
  next: SignedCheckpoint,
  proof: readonly string[],
  trustedPublicKey: KeyInput,
): { code: ComparisonCode } {
  if (!verifyCheckpoint(previous, trustedPublicKey) || !verifyCheckpoint(next, trustedPublicKey))
    return { code: 'invalid' };
  if (previous.body.logId !== next.body.logId) return { code: 'invalid' };
  if (previous.body.bootstrapSize !== next.body.bootstrapSize) return { code: 'invalid' };
  if (next.body.treeSize < previous.body.treeSize) return { code: 'rollback' };
  if (
    next.body.treeSize === previous.body.treeSize &&
    next.body.rootHash !== previous.body.rootHash
  )
    return { code: 'conflict' };
  if (next.body.issuedAt < previous.body.issuedAt) return { code: 'invalid' };
  if (
    !verifyConsistency(
      previous.body.treeSize,
      next.body.treeSize,
      previous.body.rootHash,
      next.body.rootHash,
      proof,
    )
  )
    return { code: 'invalid' };
  return { code: previous.body.treeSize === next.body.treeSize ? 'unchanged' : 'valid' };
}

export function verifyEventProof(
  bundle: EventProofBundle,
  trustedPublicKey: KeyInput,
  expected: { logId: string; eventId: string },
): { valid: boolean; code: ProofCode } {
  const fail = (code: ProofCode) => ({ valid: false, code });
  try {
    ordinary(bundle);
    exact(
      bundle,
      Object.hasOwn(bundle, 'consistencyProof')
        ? ['checkpoint', 'entry', 'inclusionProof', 'consistencyProof']
        : ['checkpoint', 'entry', 'inclusionProof'],
    );
    if (bundle.consistencyProof !== undefined) {
      if (!Array.isArray(bundle.consistencyProof) || bundle.consistencyProof.length > 64)
        return fail('invalid-format');
      for (const node of bundle.consistencyProof) decodeHash(node);
    }
    exact(expected, ['logId', 'eventId']);
    uuid(expected.logId);
    uuid(expected.eventId);
    entry(bundle.entry);
    if (!verifyCheckpoint(bundle.checkpoint, trustedPublicKey)) return fail('invalid-checkpoint');
    if (bundle.entry.logId !== expected.logId || bundle.checkpoint.body.logId !== expected.logId)
      return fail('wrong-log');
    if (bundle.entry.payload.eventId !== expected.eventId) return fail('wrong-event');
    const commitment = commitEvent(bundle.entry);
    if (
      !verifyInclusion(
        commitment,
        bundle.entry.index,
        bundle.checkpoint.body.treeSize,
        bundle.inclusionProof,
        bundle.checkpoint.body.rootHash,
      )
    )
      return fail('invalid-inclusion');
    return { valid: true, code: 'valid' };
  } catch {
    return fail('invalid-format');
  }
}
