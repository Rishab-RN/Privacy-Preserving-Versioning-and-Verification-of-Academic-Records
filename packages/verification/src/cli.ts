import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCanonical, MAX_JSON_BYTES } from './canonical.js';
import { compareCheckpoints, verifyEventProof } from './index.js';
import type { EventProofBundle, SignedCheckpoint } from './index.js';

class UsageError extends Error {}
export interface CliResult {
  valid: boolean;
  code: string;
  observation?: string;
  exitCode: 0 | 1 | 2;
}

async function boundedRead(path: string, maximum = MAX_JSON_BYTES): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid or oversized input file');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) return buffer.subarray(0, length);
      length += read.bytesRead;
    }
    throw new Error('Input file exceeds size limit');
  } finally {
    await file.close();
  }
}

/** Offline only: the public key and expected identities come from caller trust. */
export async function runCli(args: string[]): Promise<CliResult> {
  try {
    if (args[0] !== 'verify') throw new UsageError('Expected verify command');
    const options = new Map<string, string>();
    const allowed = new Set(['--bundle', '--public-key', '--log-id', '--event-id', '--previous']);
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (!name || !allowed.has(name) || !value || value.startsWith('--') || options.has(name)) {
        throw new UsageError('Invalid command options');
      }
      options.set(name, value);
    }
    const required = (name: string): string => {
      const value = options.get(name);
      if (!value) throw new UsageError('Missing option');
      return value;
    };
    const bundle = parseCanonical(
      await boundedRead(required('--bundle')),
    ) as unknown as EventProofBundle;
    const publicKey = await boundedRead(required('--public-key'), 4096);
    const checked = verifyEventProof(bundle, publicKey, {
      logId: required('--log-id'),
      eventId: required('--event-id'),
    });
    if (!checked.valid) return { ...checked, exitCode: 1 };
    const previousPath = options.get('--previous');
    if (previousPath) {
      const retained = parseCanonical(
        await boundedRead(previousPath),
      ) as unknown as SignedCheckpoint;
      // The old checkpoint is externally retained; the new path is untrusted.
      const comparison = compareCheckpoints(
        retained,
        bundle.checkpoint,
        bundle.consistencyProof ?? [],
        publicKey,
      );
      if (comparison.code !== 'valid' && comparison.code !== 'unchanged') {
        return { valid: false, code: comparison.code, exitCode: 1 };
      }
      return { ...checked, observation: comparison.code, exitCode: 0 };
    }
    return { ...checked, observation: 'not-provided', exitCode: 0 };
  } catch (error) {
    if (error instanceof UsageError) return { valid: false, code: 'usage', exitCode: 2 };
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      return { valid: false, code: 'unavailable', exitCode: 2 };
    }
    return { valid: false, code: 'invalid-format', exitCode: 1 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { exitCode, ...result } = await runCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = exitCode;
}
