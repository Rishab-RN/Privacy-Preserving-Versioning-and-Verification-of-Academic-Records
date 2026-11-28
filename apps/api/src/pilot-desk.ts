import type { Router } from 'express';
import type { PilotDeskOffering, PilotEntryForm } from '@scholarproof/contracts';
import { z } from 'zod';
import { batchFailure } from './assessment-batches.js';
import { parse, uuid } from './inputs.js';
import type { Platform } from './platform.js';
import { loadPolicy } from './publication.js';

const noQuery = z.object({}).strict();
const stage = z.enum(['cie', 'see']);

/** Read-only routes that let the pilot web screens show each person their own desks. */
export function installPilotDeskRoutes(router: Router, platform: Platform) {
  const sql = () => platform.repository.sql;

  router.get('/pilot/desk', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    parse(noQuery, request.query);
    const { rows } = await sql()
      .query<PilotDeskOffering>(
        `SELECT offering_id AS "offeringId", course_code AS "courseCode",
           section_code AS "sectionCode", term_code AS "termCode",
           department_code AS "departmentCode", entry_stages AS "entryStages", reviews, validates,
           publishes, reads_results AS "readsResults", corrects, published
         FROM assessment.my_desk($1)`,
        [digest],
      )
      .catch(batchFailure);
    response.json({ offerings: rows });
  });

  router.get('/pilot/offerings/:offeringId/entry-form/:stage', async (request, response) => {
    const { digest } = await platform.authenticate(request.get('authorization'));
    const offeringId = parse(uuid, request.params.offeringId);
    const part = parse(stage, request.params.stage);
    parse(noQuery, request.query);
    const context = (
      await sql()
        .query<{ policy_id: string; policy_version: number }>(
          'SELECT policy_id,policy_version FROM assessment.entry_context($1,$2,$3)',
          [digest, offeringId, part],
        )
        .catch(batchFailure)
    ).rows[0]!;
    const policy = loadPolicy(context.policy_id, context.policy_version);
    const form: PilotEntryForm = {
      policy: { id: policy.id, version: policy.version },
      stage: part,
      components: policy.groups
        .filter((group) => group.part === part)
        .flatMap((group) =>
          group.components
            .filter((component) => !component.optional)
            .map((component) => ({
              code: component.code,
              group: group.code,
              kind: group.kind,
              maximum: component.maximum,
            })),
        ),
      absenceAllowed: policy.absence.parts.includes(part),
    };
    response.json(form);
  });
}
