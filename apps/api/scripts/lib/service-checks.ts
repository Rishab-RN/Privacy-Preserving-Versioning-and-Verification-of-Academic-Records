export interface ServiceCheck {
  service: 'PostgreSQL' | 'MongoDB';
  probe: () => Promise<void>;
}

export interface ServiceResult {
  service: ServiceCheck['service'];
  ok: boolean;
  code?: string;
}

export class ServiceConfigurationError extends Error {
  constructor() {
    super('Local service configuration is missing or invalid');
  }
}

export function configurationValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ServiceConfigurationError();
  return value;
}

export function configuredPort(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    throw new ServiceConfigurationError();
  }
  return Number(value);
}

function errorCode(error: unknown): string {
  if (error instanceof ServiceConfigurationError) return 'CONFIGURATION_INVALID';
  let candidate = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!candidate || typeof candidate !== 'object') break;
    const current = candidate as Record<string, unknown>;
    if (current.code === '28P01' || current.code === 18) return 'AUTHENTICATION_FAILED';
    if (
      typeof current.code === 'string' &&
      ['ECONNREFUSED', 'EACCES', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(current.code)
    ) {
      return current.code;
    }
    if (current.name === 'MongoServerSelectionError') return 'SERVER_SELECTION_FAILED';
    candidate = current.cause;
  }
  // Do not print exception messages, arbitrary codes or connection strings.
  return 'CONNECTION_FAILED';
}

export function runServiceChecks(checks: readonly ServiceCheck[]): Promise<ServiceResult[]> {
  return Promise.all(
    checks.map(async ({ service, probe }): Promise<ServiceResult> => {
      try {
        await probe();
        return { service, ok: true };
      } catch (error) {
        return { service, ok: false, code: errorCode(error) };
      }
    }),
  );
}
