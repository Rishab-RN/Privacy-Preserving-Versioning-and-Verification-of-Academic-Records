import type { Router } from 'express';
import type { PilotOffering, PilotRoster } from '@scholarproof/contracts';
import { z } from 'zod';
import { ApiFailure } from './errors.js';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';
import { workflowFailure } from './workflow.js';

const noFilters = z.object({}).strict();
const cursor = z.object({ after: uuid.optional() }).strict();

export function installPilotRosterRoutes(router: Router, platform: Platform) {
  router.get('/pilot/offerings', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    parse(noFilters, request.query);
    const { rows } = await platform.repository.sql
      .query<PilotOffering>(
        `SELECT offering_id AS "offeringId", department_code AS "departmentCode",
        course_code AS "courseCode", section_code AS "sectionCode", term_code AS "termCode"
       FROM pilot.roster_offerings($1)`,
        [digest],
      )
      .catch(workflowFailure);
    if (rows.length > 500)
      throw new ApiFailure(413, 'RESULT_TOO_LARGE', 'Pilot offering list exceeds the result limit');
    response.json({ offerings: rows });
  });
  router.get('/pilot/offerings/:offeringId/roster', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const offeringId = parse(uuid, request.params.offeringId);
    const { after } = parse(cursor, request.query);
    const { rows } = await platform.repository.sql
      .query<PilotRoster['students'][number]>(
        'SELECT enrolment_id AS "enrolmentId", student_code AS "studentCode" FROM pilot.read_roster($1,$2,$3)',
        [digest, offeringId, after ?? null],
      )
      .catch(workflowFailure);
    const students = rows.slice(0, 100);
    const result: PilotRoster = {
      students,
      nextAfter: rows.length > 100 ? students[99]!.enrolmentId : null,
    };
    response.json(result);
  });
}
