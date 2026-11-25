import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  openGraph,
  rebuild,
  requireGraphSchema,
  setupSchema,
  syncOnce,
} from '../../src/provenance/graph.js';
import { graphId, readSource } from '../../src/provenance/source.js';
import type { ApprovedFact } from '../../src/provenance/source.js';

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
    const {
      WORKER_POSTGRES_USER: user,
      WORKER_POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
    } = process.env;
    if (
      !user ||
      !password ||
      !database ||
      user === process.env.POSTGRES_USER ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
      ['postgres', 'template0', 'template1'].includes(database)
    )
      throw new Error('Configure the restricted SQL worker first');
    sql = new Client({
      host: '127.0.0.1',
      port: Number(process.env.POSTGRES_PORT ?? 55432),
      database,
      user,
      password,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    await sql.connect();
    const grants = await sql.query<{
      safe: boolean;
    }>(`SELECT pg_has_role(current_user,'scholarproof_worker_access','USAGE')
      AND NOT has_table_privilege(current_user,'provenance.approved_fact','SELECT') AS safe`);
    if (!grants.rows[0]?.safe) throw new Error('Unexpected SQL worker privileges');
    if (command === 'rebuild') {
      const facts: ApprovedFact[] = [];
      await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let cursor = 0,
        size: number;
      do {
        const page = await readSource(sql, scope, cursor);
        size = page.size;
        if (size > 10000) throw new Error('Rebuild exceeds the 10,000-slot prototype limit');
        facts.push(...page.facts);
        cursor = page.next;
      } while (cursor < size);
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
