import type { SessionResponse, UserPrincipal } from '@scholarproof/contracts';
export type Session = SessionResponse & { principal: UserPrincipal };
export type Page =
  'Overview' | 'Records' | 'Evidence' | 'Review' | 'Private proofs' | 'Credential status';
export type Api = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
