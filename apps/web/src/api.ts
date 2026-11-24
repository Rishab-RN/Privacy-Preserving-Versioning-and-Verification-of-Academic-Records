export class RequestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  token?: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      signal: AbortSignal.timeout(15000),
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RequestFailure(
      'CONNECTION_UNAVAILABLE',
      'Cannot reach the service. Check the connection and try again.',
      0,
    );
  }
  if (response.status === 204) return undefined as T;
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } } | null;
    throw new RequestFailure(
      error?.error?.code ?? 'SERVICE_UNAVAILABLE',
      error?.error?.message ?? 'The service is unavailable. Try again.',
      response.status,
    );
  }
  if (value === null)
    throw new RequestFailure(
      'INVALID_RESPONSE',
      'The service returned an unreadable response.',
      502,
    );
  return value as T;
}
export const message = (error: unknown) =>
  error instanceof RequestFailure
    ? `${error.message} (${error.code})`
    : 'The action could not be completed. Try again.';
