import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeRequestStatus } from '@scholarproof/contracts';
import { withCompiledApi } from '../lib/compiled-api.js';
import { projectRoot } from '../db/config.js';
import { openWorkerRuntime, workerConfig } from '../../../worker/src/runtime.js';
import { runBatch } from '../../../worker/src/runner.js';
import { PROJECTION_COLLECTIONS } from '../../../worker/src/projection.js';

let stage = 'configuration';
try {
  const accounts = JSON.parse(
    readFileSync(join(projectRoot, '.runtime/workflow-accounts.json'), 'utf8'),
  ) as { subject: string; password: string }[];
  const fixture = JSON.parse(
    readFileSync(join(projectRoot, '.runtime/workflow-fixture.json'), 'utf8'),
  ) as { recordId: string; studentId: string };
  await withCompiledApi(async (api) => {
    stage = 'registrar login';
    const tokens: string[] = [];
    try {
      for (const account of accounts)
        tokens.push(
          ((await api.request('/auth/login', 'POST', account)) as { token: string }).token,
        );
      assert.equal(tokens.length, 2);
      stage = 'record precondition';
      const context = (await api.request(
        `/records/${fixture.recordId}/change-context`,
        'GET',
        undefined,
        tokens[0],
      )) as { latestRecordedVersion: number };
      stage = 'evidence upload';
      const evidence = (await api.request(
        `/records/${fixture.recordId}/evidence`,
        'POST',
        {
          schemaVersion: 1,
          category: 'supporting_note',
          data: { note: 'Synthetic compiled Week 4 workflow demonstration' },
        },
        tokens[0],
        randomUUID(),
      )) as { evidenceId: string };
      stage = 'proposal';
      const change = (await api.request(
        `/records/${fixture.recordId}/change-requests`,
        'POST',
        {
          expectedVersion: context.latestRecordedVersion,
          gradePoints: '8.00',
          outcome: 'passed',
          validFrom: '2000-01-01T00:00:00Z',
          validUntil: null,
          evidenceId: evidence.evidenceId,
          reason: 'Synthetic reviewed result',
        },
        tokens[0],
        randomUUID(),
      )) as ChangeRequestStatus;
      stage = 'independent approval';
      const approved = (await api.request(
        `/change-requests/${change.requestId}/approve`,
        'POST',
        { reason: 'Synthetic independent registrar approval' },
        tokens[1],
      )) as ChangeRequestStatus;
      assert.equal(approved.decision?.versionNo, context.latestRecordedVersion + 1);
      assert.equal(
        approved.deliveries.every((delivery) => delivery.state === 'pending'),
        true,
      );
      stage = 'restricted worker delivery';
      const worker = await openWorkerRuntime(workerConfig());
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const batch = await runBatch(worker.sql, worker.db);
          assert.equal(batch.failed, 0);
          if (!batch.claimed) break;
          if (attempt === 99) throw new Error('Synthetic queue did not drain');
        }
        stage = 'projection confirmation';
        const status = (await api.request(
          `/change-requests/${change.requestId}`,
          'GET',
          undefined,
          tokens[0],
        )) as ChangeRequestStatus;
        assert.equal(
          status.deliveries.every((delivery) => delivery.state === 'delivered'),
          true,
        );
        const head = await worker.db
          .collection<{ _id: string; latestRecordedVersion: number }>(PROJECTION_COLLECTIONS.heads)
          .findOne({ _id: fixture.recordId });
        assert.equal(head?.latestRecordedVersion, approved.decision!.versionNo);
      } finally {
        await worker.close();
      }
      console.info(
        'Compiled API proposal, distinct approval, durable delivery and Mongo projection passed',
      );
    } finally {
      for (const token of tokens)
        await api.request('/auth/logout', 'POST', {}, token).catch(() => {});
    }
  });
} catch {
  console.error(`Workflow smoke failed at ${stage}; no credentials or event payloads printed`);
  process.exitCode = 1;
}
