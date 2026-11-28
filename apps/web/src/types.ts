import type { SessionResponse, UserPrincipal } from '@scholarproof/contracts';
export type Session = SessionResponse & { principal: UserPrincipal };
export type Page =
  | 'Overview'
  | 'Records'
  | 'Evidence'
  | 'Review'
  | 'Provenance'
  | 'Private proofs'
  | 'Credential status'
  | 'Marks & results';
export type Api = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
