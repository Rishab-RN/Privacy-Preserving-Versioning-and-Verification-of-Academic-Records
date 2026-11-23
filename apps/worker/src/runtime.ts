import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { PROJECTION_COLLECTIONS, verifyProjectionCollections } from './projection.js';

export function workerConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key];
    if (!value || value.startsWith('replace-with-'))
      throw new Error('Configure restricted worker access with worker:setup');
    return value;
  };
  const port = (key: string, fallback: string) => {
    const value = env[key] ?? fallback;
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535)
      throw new Error('Invalid local service port');
    return Number(value);
  };
  const database = required('POSTGRES_DB');
  const user = required('WORKER_POSTGRES_USER');
  const mongoDatabase = required('WORKER_MONGO_DB');
  const mongoUser = required('WORKER_MONGO_USER');
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    ['postgres', 'template0', 'template1'].includes(database) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(mongoDatabase) ||
    ['admin', 'local', 'config'].includes(mongoDatabase) ||
    user === env.POSTGRES_USER ||
    mongoUser === env.MONGO_ROOT_USER ||
    user === env.API_POSTGRES_USER ||
    mongoUser === env.API_MONGO_USER
  ) {
    throw new Error('Use dedicated restricted worker identities and project databases');
  }
  return {
    database,
    user,
    password: required('WORKER_POSTGRES_PASSWORD'),
    port: port('POSTGRES_PORT', '55432'),
    mongoDatabase,
    mongoUser,
    mongoPassword: required('WORKER_MONGO_PASSWORD'),
    mongoPort: port('MONGO_PORT', '57017'),
  };
}

export async function openWorkerRuntime(config: ReturnType<typeof workerConfig>) {
  const sql = new Pool({
    host: '127.0.0.1',
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  sql.on('error', () => console.error('Worker PostgreSQL connection failed'));
  const mongo = new MongoClient(`mongodb://127.0.0.1:${config.mongoPort}`, {
    authSource: config.mongoDatabase,
    auth: { username: config.mongoUser, password: config.mongoPassword },
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 5000,
  });
  const close = async () => {
    await Promise.allSettled([sql.end(), mongo.close()]);
  };
  try {
    const identity = await sql.query<{ safe: boolean }>(`SELECT
      r.rolcanlogin AND r.rolinherit AND r.rolconfig IS NULL AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND (SELECT count(*) FROM pg_auth_members WHERE member=r.oid)=1
      AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='scholarproof_worker_access' AND g.rolinherit AND g.rolconfig IS NULL
        AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication OR g.rolbypassrls))
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid AND (p.rolname<>'scholarproof_worker_access' OR m.admin_option OR NOT m.inherit_option))
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.member WHERE p.rolname='scholarproof_worker_access')
      AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
      AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid OR has_schema_privilege(r.oid,oid,'CREATE'))
      AND NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('academic','access_control','evidence','workflow') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='access_control' AND c.relname IN ('password_credential','api_session')
          AND (has_table_privilege(r.oid,c.oid,'SELECT') OR has_any_column_privilege(r.oid,c.oid,'SELECT')))
      AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE ((n.nspname='academic' AND p.proname='append_grade_version') OR
               (n.nspname='workflow' AND p.proname IN ('approve_change','propose_change','reject_change','get_change')))
          AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
      AND has_function_privilege(r.oid,'workflow.claim_deliveries(integer,integer)','EXECUTE')
      AND has_function_privilege(r.oid,'workflow.ack_delivery(uuid,uuid)','EXECUTE')
      AND has_function_privilege(r.oid,'workflow.fail_delivery(uuid,uuid,text)','EXECUTE')
      AND has_table_privilege(r.oid,'workflow.domain_event','SELECT') AS safe FROM pg_roles r WHERE r.rolname=current_user`);
    if (identity.rows[0]?.safe !== true) throw new Error('Unsafe worker SQL identity');
    await mongo.connect();
    const db = mongo.db(config.mongoDatabase);
    const status = await db.command({ connectionStatus: 1, showPrivileges: true });
    const auth = status.authInfo as {
      authenticatedUsers?: { user: string; db: string }[];
      authenticatedUserPrivileges?: {
        resource: { db?: string; collection?: string };
        actions: string[];
      }[];
    };
    const seen = new Map<string, Set<string>>();
    if (
      auth.authenticatedUsers?.length !== 1 ||
      auth.authenticatedUsers[0]?.db !== config.mongoDatabase
    )
      throw new Error('Unsafe worker Mongo identity');
    const allowed = new Map<string, string[]>([
      ['', ['listCollections']],
      [PROJECTION_COLLECTIONS.events, ['find', 'insert']],
      [PROJECTION_COLLECTIONS.revisions, ['find', 'insert']],
      [PROJECTION_COLLECTIONS.heads, ['find', 'insert', 'update']],
    ]);
    for (const privilege of auth.authenticatedUserPrivileges ?? []) {
      const { resource, actions } = privilege;
      if (
        Object.keys(resource).length !== 2 ||
        resource.db !== config.mongoDatabase ||
        !allowed.has(resource.collection ?? '') ||
        resource.collection === undefined
      )
        throw new Error('Unsafe worker Mongo grants');
      const expected = allowed.get(resource.collection)!;
      if (actions.some((action) => !expected.includes(action)))
        throw new Error('Unsafe worker Mongo grants');
      const actual = seen.get(resource.collection) ?? new Set<string>();
      actions.forEach((action) => actual.add(action));
      seen.set(resource.collection, actual);
    }
    if (
      [...allowed].some(([collection, actions]) =>
        actions.some((action) => !seen.get(collection)?.has(action)),
      )
    )
      throw new Error('Missing worker Mongo grants');
    await verifyProjectionCollections(db);
    return { sql, db, close };
  } catch (error) {
    await close();
    throw error;
  }
}
