import { createPublicKey } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  compareCheckpoints,
  parseCanonical,
  verifyCheckpoint,
} from '@academic-records/verification';
import type { ComparisonCode, SignedCheckpoint } from '@academic-records/verification';
import {
  observationPath,
  readObservation,
  withObservationLock,
  writeObservation,
} from './local-state.js';

export interface CheckpointTransfer {
  checkpoint: SignedCheckpoint;
  consistencyProof: string[];
}

export async function observeCheckpoint(
  path: string,
  logId: string,
  key: ReturnType<typeof createPublicKey>,
  transfer: CheckpointTransfer,
  retain: boolean,
): Promise<{ code: ComparisonCode | 'initial'; treeSize?: number }> {
  if (
    !transfer ||
    typeof transfer !== 'object' ||
    Object.keys(transfer).length !== 2 ||
    !Array.isArray(transfer.consistencyProof) ||
    transfer.consistencyProof.length > 64 ||
    transfer.consistencyProof.some(
      (value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value),
    ) ||
    !verifyCheckpoint(transfer.checkpoint, key) ||
    transfer.checkpoint.body.logId !== logId
  )
    return { code: 'invalid' };
  return withObservationLock(path, async () => {
    const previous = readObservation(path);
    const { checkpoint, consistencyProof } = transfer;
    const comparison = previous
      ? compareCheckpoints(previous, checkpoint, consistencyProof, key).code
      : consistencyProof.length === 0
        ? 'initial'
        : 'invalid';
    if (!['valid', 'unchanged', 'initial'].includes(comparison)) return { code: comparison };
    if (retain) writeObservation(path, checkpoint, key);
    return { code: comparison, treeSize: checkpoint.body.treeSize };
  });
}

function bounded(path: string, limit: number) {
  const file = openSync(path, 'r');
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > limit) throw new Error('Invalid witness input file');
    return readFileSync(file);
  } finally {
    closeSync(file);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !['observe', 'check'].includes(command) || args.length % 2)
    throw new Error(
      'Use observe|check with --log-id, --public-key, --incoming and optional --state-dir',
    );
  const input = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!,
      value = args[index + 1]!;
    if (
      !['--log-id', '--public-key', '--incoming', '--state-dir'].includes(option) ||
      !value ||
      value.startsWith('--') ||
      input.has(option)
    )
      throw new Error('Invalid witness arguments');
    input.set(option, value);
  }
  const logId = input.get('--log-id'),
    publicPath = input.get('--public-key'),
    incoming = input.get('--incoming');
  if (!logId || !publicPath || !incoming)
    throw new Error('Provide --log-id, --public-key and --incoming');
  const directory =
    input.get('--state-dir') ??
    fileURLToPath(new URL('../../../.runtime/log-witness/', import.meta.url));
  const key = createPublicKey(bounded(publicPath, 16 * 1024));
  const transfer = parseCanonical(bounded(incoming, 16 * 1024)) as unknown as CheckpointTransfer;
  const result = await observeCheckpoint(
    observationPath(directory, logId),
    logId,
    key,
    transfer,
    command === 'observe',
  );
  console.info(JSON.stringify({ ...result, logId }));
  process.exitCode = result.treeSize === undefined ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Witness unavailable or invalid input. Check its arguments, files and lock.');
    process.exitCode = 2;
  });
}
