import { createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyEventProof } from '@academic-records/verification';
import type { EventProofBundle } from '@academic-records/verification';
import { ApiFailure } from './errors.js';
import type { PrivacyService } from './privacy-runtime.js';

const localPublicKey = fileURLToPath(
  new URL('../../../.runtime/log-keys/public.pem', import.meta.url),
);

export function loadHistoryKey() {
  try {
    const key = createPublicKey(readFileSync(process.env.ZK_LOG_PUBLIC_KEY_FILE ?? localPublicKey));
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch {
    // The verifier can run before the separate log signer has been provisioned.
  }
  throw new ApiFailure(503, 'HISTORY_UNAVAILABLE', 'Trusted log verification key is unavailable');
}

export async function verifyCredentialHistory(
  issuer: Pick<PrivacyService, 'readArtifact'>,
  artifact: string,
  input: unknown,
  trustedKey: KeyObject,
) {
  const claims = await issuer.readArtifact(artifact).catch(() => {
    throw new ApiFailure(
      400,
      'INVALID_ISSUER_ARTIFACT',
      'Credential signature or profile is invalid',
    );
  });
  const bundle = input as EventProofBundle | null;
  const payload = bundle?.entry?.payload;
  const digest = createHash('sha256').update(artifact, 'utf8').digest('hex');
  if (
    !bundle ||
    !payload ||
    payload.kind !== 'credential.issued' ||
    payload.institutionId !== claims.institutionId ||
    payload.credentialId !== claims.credentialId ||
    payload.recordId !== claims.recordId ||
    payload.versionNo !== claims.versionNo ||
    payload.artifactDigest !== digest ||
    typeof payload.eventId !== 'string'
  ) {
    throw new ApiFailure(
      400,
      'HISTORY_BINDING_MISMATCH',
      'Issuance evidence does not match the credential',
    );
  }
  if (
    !verifyEventProof(bundle, trustedKey, { logId: claims.institutionId, eventId: payload.eventId })
      .valid
  )
    throw new ApiFailure(
      400,
      'INVALID_HISTORY_PROOF',
      'Signed checkpoint or inclusion proof is invalid',
    );
  return {
    status: 'anchored' as const,
    credentialId: claims.credentialId,
    recordId: claims.recordId,
    versionNo: claims.versionNo,
    eventId: payload.eventId,
    treeSize: bundle.checkpoint.body.treeSize,
    checkpointAt: bundle.checkpoint.body.issuedAt,
    logKeyId: bundle.checkpoint.body.keyId,
  };
}
