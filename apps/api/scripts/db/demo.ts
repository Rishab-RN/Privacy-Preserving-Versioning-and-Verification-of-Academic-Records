import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';
import { runDatabaseCommand } from './command.js';
import { MigrationError } from './migrations.js';

await runDatabaseCommand(async (client) => {
  const rows = await client.query<{
    student_id: string;
    record_id: string;
    version_no: number;
    known_at: string;
  }>(`
    SELECT s.student_id, gr.record_id, gv.version_no, gv.recorded_at::text AS known_at
    FROM academic.student s
    JOIN academic.institution i ON i.institution_id=s.institution_id
    JOIN academic.enrolment e ON e.student_id=s.student_id
    JOIN academic.course_offering co ON co.offering_id=e.offering_id
    JOIN academic.course c ON c.course_id=co.course_id
    JOIN academic.grade_record gr ON gr.enrolment_id=e.enrolment_id
    JOIN academic.grade_version gv ON gv.record_id=gr.record_id
    WHERE i.institution_code='DEMO_UNIVERSITY' AND s.student_code='DEMO_STUDENT_001' AND c.course_code='DEMO_C1'
    ORDER BY gv.version_no
  `);
  if (rows.rowCount !== 2)
    throw new MigrationError('Run db:migrate and db:seed before the temporal demonstration');
  const [before, after] = rows.rows;
  if (!before || !after) throw new MigrationError('Synthetic revision fixture is incomplete');
  const query = readFileSync(join(projectRoot, 'db/queries/transcript_as_of.sql'), 'utf8');
  for (const [label, known] of [
    ['Before correction', before.known_at],
    ['After correction', after.known_at],
  ]) {
    const result = await client.query(query, [before.student_id, known, '2026-05-01T00:00:00Z']);
    console.info(label);
    console.table(
      result.rows
        .filter((row) => row.course_code === 'DEMO_C1')
        .map(({ course_code, version_no, grade_points, outcome }) => ({
          course_code,
          version_no,
          grade_points,
          outcome,
        })),
    );
  }
  if (process.argv.includes('--plan')) {
    await client.query(
      'ANALYZE academic.enrolment, academic.grade_record, academic.grade_version, academic.grade_temporal_segment',
    );
    const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, [
      before.student_id,
      after.known_at,
      '2026-05-01T00:00:00Z',
    ]);
    const output = join(projectRoot, '.runtime');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'transcript-query-plan.json'),
      JSON.stringify(result.rows, null, 2) + '\n',
    );
    console.info(
      'Saved actual query plan to ignored .runtime/transcript-query-plan.json; small-fixture plans are not scalability benchmarks',
    );
  }
});
