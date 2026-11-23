import { setTimeout as delay } from 'node:timers/promises';
import { openWorkerRuntime, workerConfig } from './runtime.js';
import { replayJournal, runBatch } from './runner.js';

let stopping = false;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopping = true;
    abort.abort();
  });
let runtime: Awaited<ReturnType<typeof openWorkerRuntime>> | undefined;
try {
  if (
    process.argv.slice(2).some((argument) => !['--once', '--replay'].includes(argument)) ||
    process.argv.length > 3
  )
    throw new Error('Invalid worker mode');
  runtime = await openWorkerRuntime(workerConfig());
  if (process.argv.includes('--replay')) {
    console.info(
      `Replayed ${await replayJournal(runtime.sql, runtime.db)} committed events; delivery leases were not changed`,
    );
  } else {
    do {
      const result = await runBatch(runtime.sql, runtime.db, () => stopping);
      console.info(
        `Worker batch: ${result.delivered} delivered, ${result.failed} failed, ${result.stale} stale leases`,
      );
      if (process.argv.includes('--once') || stopping) break;
      await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
    } while (!stopping);
  }
} catch {
  console.error(
    'Worker stopped with a configuration or service failure; no event payloads or credentials logged',
  );
  process.exitCode = 1;
} finally {
  await runtime?.close();
}
