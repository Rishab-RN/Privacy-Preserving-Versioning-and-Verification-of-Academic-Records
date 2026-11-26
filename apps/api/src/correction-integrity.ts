import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import { z } from 'zod';
import {
  compareCheckpoints,
  parseCanonical,
  verifyCheckpoint,
  verifyEventProof,
} from '@academic-records/verification';
import type { EventProofBundle, SignedCheckpoint } from '@academic-records/verification';
import type { CorrectionIntegrity } from '@scholarproof/contracts';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';
import { loadHistoryKey } from './privacy-history.js';
import { workflowFailure } from './workflow.js';

const maxBytes = 16 * 1024;
const counter = z.number().int().nonnegative().safe();
const contextBase = { scope: uuid, head: counter };
const contextSchema = z.discriminatedUnion('status', [
  z.object({ ...contextBase, status: z.literal('ready'), eventId: uuid, matches: z.boolean() }),
  z.object({ ...contextBase, status: z.literal('not-approved') }),
  z.object({ ...contextBase, status: z.literal('journal-mismatch') }),
]);
const input = z
  .object({
    bundle: z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text, 'utf8') <= maxBytes),
  })
  .strict();
const localWitness = fileURLToPath(new URL('../../../.runtime/log-witness/', import.meta.url));

async function retained(scope: string, key: ReturnType<typeof loadHistoryKey>) {
  const directory = process.env.LOG_WITNESS_DIRECTORY ?? localWitness;
  try {
    const file = await open(join(directory, scope + '.json'), 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) return null;
      const checkpoint = parseCanonical(await file.readFile()) as unknown as SignedCheckpoint;
      return verifyCheckpoint(checkpoint, key) && checkpoint.body.logId === scope
        ? checkpoint
        : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export function installCorrectionIntegrity(router: Router, platform: Platform) {
  router.post('/change-requests/:requestId/integrity', async (req, res) => {
    const { digest } = await platform.authenticate(req.get('authorization'));
    const requestId = parse(uuid, req.params.requestId);
    const { bundle: source } = parse(input, req.body);
    let bundle: EventProofBundle | null = null;
    try {
      bundle = parseCanonical(Buffer.from(source, 'utf8')) as unknown as EventProofBundle;
    } catch {
      // SQL still checks the scoped correction when the uploaded proof is unreadable.
    }
    const context = await platform.repository.sql
      .query<{ value: unknown }>('SELECT transparency.review_event($1,$2,$3::jsonb) AS value', [
        digest,
        requestId,
        JSON.stringify(bundle?.entry ?? null),
      ])
      .then(({ rows }) => contextSchema.parse(rows[0]?.value), workflowFailure);
    const result: CorrectionIntegrity = {
      event: context.status === 'ready' ? 'invalid-proof' : context.status,
      witness: 'unchecked',
      committed: context.head,
      checkpointSize: null,
      retainedSize: null,
    };
    if (context.status === 'not-approved') return res.json(result);
    let key: ReturnType<typeof loadHistoryKey>;
    try {
      key = loadHistoryKey();
    } catch {
      if (context.status === 'ready') result.event = 'key-unavailable';
      return res.json(result);
    }
    const previous = await retained(context.scope, key);
    if (previous) result.retainedSize = previous.body.treeSize;
    if (previous && context.head < previous.body.treeSize) {
      result.witness = 'journal-behind-witness';
    }
    if (context.status !== 'ready') return res.json(result);
    if (
      !bundle ||
      !verifyEventProof(bundle, key, { logId: context.scope, eventId: context.eventId }).valid
    )
      return res.json(result);
    const size = bundle.checkpoint.body.treeSize;
    result.checkpointSize = size;
    if (!context.matches) {
      result.event = 'journal-mismatch';
      return res.json(result);
    }
    result.event = size > context.head ? 'journal-mismatch' : 'verified';
    if (result.witness === 'journal-behind-witness') return res.json(result);
    if (!previous) result.witness = 'unavailable';
    else if (size < previous.body.treeSize) result.witness = 'older-export';
    else {
      const proof = size === previous.body.treeSize ? [] : (bundle.consistencyProof ?? []);
      const comparison = compareCheckpoints(previous, bundle.checkpoint, proof, key).code;
      result.witness =
        comparison === 'unchanged'
          ? 'matched'
          : comparison === 'valid'
            ? 'extended'
            : comparison === 'conflict'
              ? 'split-view'
              : 'invalid-consistency';
    }
    return res.json(result);
  });
}
