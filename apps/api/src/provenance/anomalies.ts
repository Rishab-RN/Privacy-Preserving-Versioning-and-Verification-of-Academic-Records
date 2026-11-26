import { open } from 'node:fs/promises';
import type { Driver } from 'neo4j-driver';
import { z } from 'zod';
import type { AnomalyReview } from '@scholarproof/contracts';
import { cursorFor } from './graph.js';
import { graphId } from './source.js';

const features = z.enum([
  'delta',
  'missingDelta',
  'record30d',
  'course30d',
  'proposer30d',
  'pair30d',
  'evidence30d',
]);
const timestamp = z.iso.datetime();
const unit = z.number().min(0).max(1);
const count = z.number().int().min(0).max(10000);
const maxBytes = 10 * 1024 * 1024;
const row = z
  .object({
    requestId: graphId,
    recordId: graphId,
    version: z.number().int().positive().max(2147483647),
    occurredAt: timestamp,
    score: unit,
    rank: count.min(1),
    flagged: z.boolean(),
    rules: z.array(features).max(5),
    signals: z
      .array(
        z
          .object({
            feature: features,
            value: z.number().int().min(-1000).max(10000),
            effect: unit,
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
const snapshot = z
  .object({
    scope: graphId,
    through: count,
    syncedAt: timestamp.nullable(),
    generatedAt: timestamp,
    modelVersion: z.string().regex(/^isolation-forest-graph-v1-[a-f0-9]{16}$/),
    featureSchema: z.literal('decision-features-v1'),
    trainedOn: z.literal('synthetic'),
    threshold: unit,
    rows: z.array(row).max(10000),
  })
  .strict()
  .refine((data) => {
    return (
      data.rows.length <= data.through &&
      new Set(data.rows.map((item) => item.requestId)).size === data.rows.length &&
      data.rows.every(
        (item, index) =>
          item.rank === index + 1 && (index === 0 || item.score <= data.rows[index - 1]!.score),
      )
    );
  });

export async function loadAnomalyReview(
  scope: string,
  committed: number,
  graph: Driver | undefined,
  target?: { recordId: string; version: number },
): Promise<AnomalyReview> {
  graphId.parse(scope);
  let data: z.infer<typeof snapshot>;
  try {
    const file = await open(
      new URL(`../../../../.runtime/anomaly/${scope}.json`, import.meta.url),
      'r',
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid snapshot size');
      data = snapshot.parse(JSON.parse(await file.readFile('utf8')));
      if (data.scope !== scope) throw new Error('Snapshot scope mismatch');
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing =
      error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    return {
      status: 'unavailable',
      committed,
      reason: missing ? 'missing-snapshot' : 'invalid-snapshot',
    };
  }
  let head: Awaited<ReturnType<typeof cursorFor>>;
  try {
    if (!graph) throw new Error('Graph unavailable');
    head = await cursorFor(graph, scope);
  } catch {
    return { status: 'unavailable', committed, reason: 'graph-unavailable' };
  }
  const {
    rows,
    through,
    syncedAt,
    generatedAt,
    trainedOn,
    modelVersion,
    featureSchema,
    threshold,
  } = data;
  const current = through === committed && head.cursor === committed && head.syncedAt === syncedAt;
  return {
    through,
    generatedAt,
    trainedOn,
    modelVersion,
    featureSchema,
    threshold,
    status: current ? 'current' : 'stale',
    committed,
    total: rows.length,
    selected:
      current && target
        ? (rows.find(
            (item) => item.recordId === target.recordId && item.version === target.version,
          ) ?? null)
        : null,
    queue: current ? rows.slice(0, 20) : [],
  };
}
