import type { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  openGraph,
  rebuild,
  requireGraphSchema,
  setupSchema,
  syncOnce,
} from '../../src/provenance/graph.js';
import { graphId, readSnapshot } from '../../src/provenance/source.js';
import { openWorkerSql } from './worker-sql.js';

const [command, scopeArg, ...extra] = process.argv.slice(2);
if (
  !command ||
  !['setup', 'sync', 'watch', 'rebuild'].includes(command) ||
  extra.length ||
  (command === 'setup') !== (scopeArg === undefined)
)
  throw new Error('Use setup or sync|watch|rebuild <institution UUID>');
const graph = openGraph();
if (!graph) throw new Error('Configure the graph using graph:configure');
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());
let sql: Client | undefined;
try {
  if (command === 'setup') {
    await setupSchema(graph);
    console.info('Neo4j connected and provenance constraints are online.');
  } else {
    const scope = graphId.parse(scopeArg);
    await requireGraphSchema(graph);
    sql = await openWorkerSql();
    if (command === 'rebuild') {
      await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { facts, size } = await readSnapshot(sql, scope);
      await sql.query('COMMIT');
      console.info(await rebuild(graph, scope, size, facts));
    } else {
      do {
        try {
          for (let page = 0; page < 25 && !abort.signal.aborted; page++) {
            const result = await syncOnce(graph, sql, scope);
            if (result.advanced || command === 'sync') console.info(result);
            if (!result.advanced || result.through >= result.size) break;
          }
        } catch (error) {
          if (command === 'sync') throw error;
          console.error('Graph sync unavailable. Will retry without advancing the cursor.');
        }
        if (command === 'watch' && !abort.signal.aborted)
          await delay(3000, undefined, { signal: abort.signal }).catch(() => {});
      } while (command === 'watch' && !abort.signal.aborted);
    }
  }
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  console.error(
    'Graph operation failed' + (code && /^[a-z0-9._]+$/i.test(code) ? ` (${code})` : ''),
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([sql?.end(), graph.close()]);
}
