export interface ApiConfig {
  host: string;
  port: number;
  environment: 'development' | 'test' | 'production';
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawPort = env.API_PORT ?? '4000';
  if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65535) {
    throw new Error('API_PORT must be an integer from 1 to 65535');
  }

  const host = (env.API_HOST ?? '127.0.0.1').trim();
  if (!host) {
    throw new Error('API_HOST must not be empty');
  }

  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) {
    throw new Error('NODE_ENV must be development, test or production');
  }

  return { host, port: Number(rawPort), environment: environment as ApiConfig['environment'] };
}
