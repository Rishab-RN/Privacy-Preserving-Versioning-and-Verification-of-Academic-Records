import express from 'express';
import type { ApiErrorResponse, LivenessResponse } from '@scholarproof/contracts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health/live', (_request, response) => {
    const body: LivenessResponse = { status: 'ok', service: 'scholarproof-api' };
    response.status(200).json(body);
  });

  app.use((_request, response) => {
    const body: ApiErrorResponse = {
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    };
    response.status(404).json(body);
  });

  return app;
}
