import express from 'express';
import { z } from 'zod';
import type { ErrorRequestHandler } from 'express';
import type { ApiErrorResponse, LivenessResponse } from '@scholarproof/contracts';
import { ApiFailure, notFound } from './errors.js';
import { evidenceInput, loginInput, parse, transcriptInput, uuid } from './inputs.js';
import type { Platform } from './platform.js';
import { WindowLimiter } from './security.js';
import { installWorkflowRoutes } from './workflow.js';
import { installPrivacyRoutes } from './privacy.js';
import type { Driver } from 'neo4j-driver';
import { installProvenanceRoutes } from './provenance/routes.js';
import { installCorrectionIntegrity } from './correction-integrity.js';
import { installPilotRosterRoutes } from './pilot-roster.js';
import { installAssessmentBatchRoutes } from './assessment-batches.js';
import { installPublicationRoutes } from './publication.js';
import { installPvpRoutes } from './pvp.js';
import { installPilotDeskRoutes } from './pilot-desk.js';

export function createApp(platform?: Platform, graph?: Driver) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health/live', (_request, response) => {
    const body: LivenessResponse = { status: 'ok', service: 'scholarproof-api' };
    response.status(200).json(body);
  });

  const api = express.Router();
  const loginLimiter = new WindowLimiter(10, 15 * 60_000);
  const requestLimiter = new WindowLimiter(100, 60_000);
  api.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!platform) return next(new ApiFailure(503, 'NOT_CONFIGURED', 'Data API is not configured'));
    try {
      requestLimiter.take(request.socket.remoteAddress ?? 'unknown');
      if (request.method === 'POST') {
        if (!request.is('application/json'))
          throw new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  api.use(express.json({ limit: 72 * 1024, strict: true, inflate: false }));
  api.post(
    '/auth/login',
    (request, _response, next) => {
      try {
        loginLimiter.take(request.socket.remoteAddress ?? 'unknown');
        next();
      } catch (error) {
        next(error);
      }
    },
    async (request, response) => {
      const input = parse(loginInput, request.body);
      response.json(await platform!.login(input.subject, input.password));
    },
  );
  api.get('/auth/me', async (request, response) => {
    response.json((await platform!.authenticate(request.get('authorization'))).principal);
  });
  api.post('/auth/logout', async (request, response) => {
    const { digest } = await platform!.authenticate(request.get('authorization'));
    await platform!.repository.revoke(digest);
    response.status(204).end();
  });
  api.get('/students/:studentId/transcript', async (request, response) => {
    const { principal } = await platform!.authenticate(request.get('authorization'));
    const id = parse(uuid, request.params.studentId);
    const query = parse(transcriptInput, request.query);
    const now = new Date().toISOString();
    response.json(
      await platform!.transcript(principal, id, query.knownAt ?? now, query.effectiveAt ?? now),
    );
  });
  api.get('/students', async (request, response) => {
    const { principal } = await platform!.authenticate(request.get('authorization'));
    const students = await platform!.repository.students(principal.userId);
    if (students.length > 500)
      throw new ApiFailure(
        413,
        'RESULT_TOO_LARGE',
        'Student directory exceeds prototype result limit',
      );
    response.json({ students });
  });
  api.get('/records/:recordId/history', async (request, response) => {
    const { principal } = await platform!.authenticate(request.get('authorization'));
    const recordId = parse(uuid, request.params.recordId);
    const { before } = parse(
      z
        .object({
          before: z
            .string()
            .regex(/^[1-9]\d{0,9}$/)
            .transform(Number)
            .pipe(z.number().int().max(2147483647))
            .optional(),
        })
        .strict(),
      request.query,
    );
    const history = await platform!.repository.recordHistory(principal.userId, recordId, before);
    if (!history) throw notFound();
    response.json(history);
  });
  api.post('/records/:recordId/evidence', async (request, response) => {
    const { principal } = await platform!.authenticate(request.get('authorization'));
    const id = parse(uuid, request.params.recordId);
    const key = parse(uuid, request.get('idempotency-key'));
    response
      .status(201)
      .json(await platform!.upload(principal, id, key, parse(evidenceInput, request.body)));
  });
  api.get('/evidence/:evidenceId', async (request, response) => {
    const { principal } = await platform!.authenticate(request.get('authorization'));
    response.json(await platform!.evidence(principal, parse(uuid, request.params.evidenceId)));
  });
  if (platform) {
    installWorkflowRoutes(api, platform);
    installPrivacyRoutes(api, platform);
    installProvenanceRoutes(api, platform, graph);
    installCorrectionIntegrity(api, platform);
    installPilotRosterRoutes(api, platform);
    installAssessmentBatchRoutes(api, platform);
    installPublicationRoutes(api, platform);
    installPvpRoutes(api, platform);
    installPilotDeskRoutes(api, platform);
  }
  app.use('/api/v1', api);

  app.use((_request, response) => {
    const body: ApiErrorResponse = {
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    };
    response.status(404).json(body);
  });

  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    let failure: ApiFailure;
    if (error instanceof ApiFailure) failure = error;
    else {
      const status =
        error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
      if (status === 413)
        failure = new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the limit');
      else if (status === 400)
        failure = new ApiFailure(400, 'INVALID_JSON', 'Malformed JSON request');
      else if (status === 415)
        failure = new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content encoding');
      else
        failure = new ApiFailure(503, 'SERVICE_UNAVAILABLE', 'A required service is unavailable');
    }
    if (failure.status === 429) response.setHeader('Retry-After', '60');
    if (failure.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    const body: ApiErrorResponse = { error: { code: failure.code, message: failure.message } };
    response.status(failure.status).json(body);
  };
  app.use(errors);

  return app;
}
