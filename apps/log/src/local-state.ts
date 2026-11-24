import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  canonicalBytes,
  checkpointKeyId,
  parseCanonical,
  verifyCheckpoint,
} from '@academic-records/verification';
import type { SignedCheckpoint } from '@academic-records/verification';

export function ensureSigningKeys(directory: string) {
  mkdirSync(directory, { recursive: true });
  const privatePath = join(directory, 'private.pem'),
    publicPath = join(directory, 'public.pem');
  if (!existsSync(privatePath) && !existsSync(publicPath)) {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(privatePath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(publicPath, pair.publicKey.export({ format: 'pem', type: 'spki' }), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (!existsSync(privatePath) || !existsSync(publicPath))
    throw new Error('Incomplete signing key pair; no key was replaced');
  if (!lstatSync(privatePath).isFile() || !lstatSync(publicPath).isFile())
    throw new Error('Signing keys must be regular files');
  const privateKey = createPrivateKey(readFileSync(privatePath)),
    publicKey = createPublicKey(readFileSync(publicPath));
  if (checkpointKeyId(createPublicKey(privateKey)) !== checkpointKeyId(publicKey))
    throw new Error('Signing key pair differs; existing files preserved');
  return { privateKey, publicKey, privatePath, publicPath };
}

export function observationPath(directory: string, logId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(logId))
    throw new Error('Invalid log identifier');
  return join(directory, logId + '.json');
}

export function readObservation(path: string): SignedCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).size > 16384)
    throw new Error('Invalid retained checkpoint file');
  return parseCanonical(readFileSync(path)) as unknown as SignedCheckpoint;
}

export function writeObservation(
  path: string,
  checkpoint: SignedCheckpoint,
  publicKey: ReturnType<typeof createPublicKey>,
) {
  if (!verifyCheckpoint(checkpoint, publicKey))
    throw new Error('Refusing to retain an invalid checkpoint');
  const previous = readObservation(path);
  if (
    previous &&
    (!verifyCheckpoint(previous, publicKey) ||
      previous.body.logId !== checkpoint.body.logId ||
      previous.body.bootstrapSize !== checkpoint.body.bootstrapSize ||
      previous.body.issuedAt > checkpoint.body.issuedAt ||
      previous.body.treeSize > checkpoint.body.treeSize ||
      (previous.body.treeSize === checkpoint.body.treeSize &&
        previous.body.rootHash !== checkpoint.body.rootHash))
  )
    throw new Error('Refusing retained-checkpoint regression or conflict');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, canonicalBytes(checkpoint), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Serialize local publishers; stale lock removal requires explicit operator review. */
export async function withObservationLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + '.lock';
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try {
    return await operation();
  } finally {
    unlinkSync(lock);
  }
}
