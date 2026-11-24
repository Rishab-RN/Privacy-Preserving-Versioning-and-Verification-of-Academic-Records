import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connectTestClient, fixture } from './helpers.js';

const integrityFailure = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  ['23503', '23514', '55000'].includes((error as { code?: string }).code ?? '');

test('BCNF storage removes dependent copies while retaining scope, history and runtime boundaries', async (context) => {
  const client = await connectTestClient();
  context.after(() => client.end());

  await context.test(
    'physical relations exclude derived tenant, predecessor and fixed protocol columns',
    async () => {
      const removed: Record<string, string[]> = {
        'academic.student': ['programme_id'],
        'academic.course_offering': ['institution_id'],
        'academic.enrolment': ['institution_id'],
        'academic.grade_version': ['institution_id', 'previous_version_no'],
        'academic.grade_temporal_segment': ['institution_id'],
        'access_control.password_credential': ['profile'],
        'evidence.reference': ['institution_id', 'document_schema_version'],
        'workflow.change_request': ['record_id'],
        'workflow.decision': ['decision_code'],
        'workflow.domain_event': ['record_id'],
        'workflow.outbox_delivery': ['consumer'],
      };
      const result = await client.query<{ relation: string; column_name: string }>(`
      SELECT n.nspname||'.'||c.relname AS relation,a.attname AS column_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r','p') AND n.nspname IN ('academic','access_control','evidence','workflow')
    `);
      for (const [relation, columns] of Object.entries(removed)) {
        for (const column of columns)
          assert.equal(
            result.rows.some((row) => row.relation === relation && row.column_name === column),
            false,
            `${relation}.${column} must be computed rather than physically repeated`,
          );
      }
      const tables = new Set(result.rows.map((row) => row.relation));
      assert.equal(tables.size, 21);
      assert.equal(tables.has('academic.student_programme'), true);
      const contexts = await client.query<{ relkind: string; name: string }>(`
      SELECT c.relkind,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('academic','access_control','evidence','workflow') AND c.relname LIKE '%\\_context' ESCAPE '\\'
    `);
      assert.ok(contexts.rowCount);
      assert.ok(contexts.rows.every((row) => row.relkind === 'v'));
    },
  );

  await context.test(
    'every committed student has exactly one same-institution programme link',
    async () => {
      const f = await fixture(client);
      const link = await client.query<{ programme_id: string }>(
        'SELECT programme_id FROM academic.student_programme WHERE student_id=$1',
        [f.id('student')],
      );
      assert.deepEqual(link.rows, [{ programme_id: f.id('programme') }]);
      const missing = randomUUID();
      await client.query('BEGIN');
      try {
        await client.query(
          "INSERT INTO academic.student(student_id,institution_id,student_code,admission_year) VALUES($1,$2,'MISSING_LINK',2026)",
          [missing, f.id('institution')],
        );
        await assert.rejects(client.query('COMMIT'), integrityFailure);
      } finally {
        await client.query('ROLLBACK');
      }
      assert.equal(
        (await client.query('SELECT 1 FROM academic.student WHERE student_id=$1', [missing]))
          .rowCount,
        0,
      );
      await assert.rejects(
        client.query('UPDATE academic.student_programme SET programme_id=$1 WHERE student_id=$2', [
          f.id('otherProgramme'),
          f.id('student'),
        ]),
        integrityFailure,
      );
      await assert.rejects(
        client.query('DELETE FROM academic.student_programme WHERE student_id=$1', [
          f.id('student'),
        ]),
        integrityFailure,
      );
      await assert.rejects(
        client.query('UPDATE academic.programme SET institution_id=$1 WHERE programme_id=$2', [
          f.id('otherInstitution'),
          f.id('programme'),
        ]),
        integrityFailure,
      );
      await assert.rejects(
        client.query('UPDATE academic.student SET institution_id=$1 WHERE student_id=$2', [
          f.id('otherInstitution'),
          f.id('student'),
        ]),
        integrityFailure,
      );
    },
  );

  await context.test(
    'derived offering, enrolment and record scope cannot cross institutions',
    async () => {
      const f = await fixture(client);
      const foreign = await fixture(client);
      for (const [term, scheme] of [
        [foreign.id('term'), f.id('scheme')],
        [f.id('term'), foreign.id('scheme')],
      ])
        await assert.rejects(
          client.query(
            'INSERT INTO academic.course_offering(offering_id,course_id,term_id,scheme_id,credits) VALUES($1,$2,$3,$4,4)',
            [randomUUID(), f.id('course'), term, scheme],
          ),
          integrityFailure,
        );
      await assert.rejects(
        client.query(
          'INSERT INTO academic.enrolment(enrolment_id,student_id,offering_id) VALUES($1,$2,$3)',
          [randomUUID(), f.id('student'), foreign.id('offering')],
        ),
        integrityFailure,
      );
      await assert.rejects(
        client.query(
          'INSERT INTO academic.grade_record(record_id,institution_id,enrolment_id) VALUES($1,$2,$3)',
          [randomUUID(), f.id('institution'), foreign.id('enrolment')],
        ),
        integrityFailure,
      );
      for (const [table, key] of [
        ['course', 'course_id'],
        ['academic_term', 'term_id'],
      ] as const)
        await assert.rejects(
          client.query(`UPDATE academic.${table} SET institution_id=$1 WHERE ${key}=$2`, [
            foreign.id('institution'),
            f.id(table === 'course' ? 'course' : 'term'),
          ]),
          integrityFailure,
        );
    },
  );

  await context.test(
    'workflow decisions and frozen event envelopes retain same-record binding',
    async () => {
      const f = await fixture(client);
      const foreign = await fixture(client);
      const token = randomBytes(32).toString('hex');
      await client.query(
        'INSERT INTO access_control.api_session(token_digest,user_id) VALUES($1,$2)',
        [token, f.id('author')],
      );
      const evidence = randomUUID();
      await client.query(
        `INSERT INTO evidence.reference(evidence_id,record_id,submitted_by,request_key,category,digest_sha256,size_bytes)
       VALUES($1,$2,$3,$4,'supporting_note',$5,128)`,
        [evidence, f.id('record'), f.id('author'), randomUUID(), 'a'.repeat(64)],
      );
      await client.query("UPDATE evidence.reference SET state='available' WHERE evidence_id=$1", [
        evidence,
      ]);
      const proposal = await client.query<{ request_id: string }>(
        "SELECT workflow.propose_change($1,$2,$3,0,7,'passed','2026-01-01T00:00:00Z',NULL,$4,'Normalized binding fixture') AS request_id",
        [token, f.id('record'), randomUUID(), evidence],
      );
      const request = proposal.rows[0]!.request_id;
      await assert.rejects(
        client.query(
          "INSERT INTO workflow.decision(request_id,record_id,decider_id,reason) VALUES($1,$2,$3,'Wrong record')",
          [request, foreign.id('record'), f.id('author')],
        ),
        integrityFailure,
      );
      const event = await client.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM workflow.domain_event WHERE request_id=$1',
        [request],
      );
      const eventId = randomUUID();
      const payload = {
        ...event.rows[0]!.payload,
        eventId,
        kind: 'request.rejected',
        recordId: foreign.id('record'),
      };
      await assert.rejects(
        client.query(
          "INSERT INTO workflow.domain_event(event_id,request_id,kind,occurred_at,payload) VALUES($1,$2,'request.rejected',clock_timestamp(),$3::jsonb)",
          [eventId, request, JSON.stringify(payload)],
        ),
        integrityFailure,
      );
      // JSON null does not compare like SQL text: `payload->>'eventId' = id`
      // yields UNKNOWN for null, which a plain CHECK may accept. Identity
      // binding must reject null and mismatched protocol fields explicitly.
      for (const [field, wrongValue] of [
        ['eventId', randomUUID()],
        ['requestId', randomUUID()],
        ['kind', 'request.submitted'],
        ['schemaVersion', 2],
      ] as const) {
        for (const value of [null, wrongValue]) {
          const identity = randomUUID();
          const malformed = {
            ...event.rows[0]!.payload,
            eventId: identity,
            requestId: request,
            kind: 'request.rejected',
            [field]: value,
          };
          await client.query('BEGIN');
          try {
            await assert.rejects(
              client.query(
                "INSERT INTO workflow.domain_event(event_id,request_id,kind,occurred_at,payload) VALUES($1,$2,'request.rejected',clock_timestamp(),$3::jsonb)",
                [identity, request, JSON.stringify(malformed)],
              ),
              (error: unknown) =>
                !!error &&
                typeof error === 'object' &&
                (error as { code?: string }).code === '23514',
              `Event ${field} must reject ${value === null ? 'JSON null' : 'a mismatch'}`,
            );
          } finally {
            await client.query('ROLLBACK');
          }
        }
      }
      assert.equal(
        (await client.query('SELECT 1 FROM workflow.decision WHERE request_id=$1', [request]))
          .rowCount,
        0,
      );
    },
  );

  await context.test(
    'context projections reconstruct fixed metadata without granting academic writes',
    async () => {
      const f = await fixture(client);
      await f.append(0, 7);
      const version = await client.query<{
        institution_id: string;
        previous_version_no: number | null;
      }>(
        'SELECT institution_id,previous_version_no FROM academic.grade_version_context WHERE record_id=$1',
        [f.id('record')],
      );
      assert.deepEqual(version.rows, [
        { institution_id: f.id('institution'), previous_version_no: null },
      ]);
      const unsafe = await client.query<{ name: string; role_name: string }>(`
      SELECT n.nspname||'.'||c.relname AS name,r.rolname AS role_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN pg_roles r
      WHERE n.nspname='academic' AND c.relkind IN ('r','p')
        AND r.rolname IN ('scholarproof_api_access','scholarproof_worker_access')
        AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))
    `);
      assert.deepEqual(unsafe.rows, []);
      for (const role of ['scholarproof_api_access', 'scholarproof_worker_access']) {
        await client.query(`SET ROLE ${role}`);
        try {
          await assert.rejects(
            client.query('DELETE FROM academic.student_programme WHERE student_id=$1', [
              f.id('student'),
            ]),
            (error: unknown) =>
              !!error && typeof error === 'object' && (error as { code?: string }).code === '42501',
          );
        } finally {
          await client.query('RESET ROLE');
        }
      }
    },
  );
});
