export type CaseErrorCode =
  | 'INVALID_DATE'
  | 'INVALID_CALENDAR'
  | 'INVALID_CREDITS'
  | 'INVALID_STUDENT'
  | 'TERM_MISMATCH'
  | 'POLICY_INVALID'
  | 'UNKNOWN_POLICY';

/** Malformed input or configuration. Ineligibility is a decision, never an error. */
export class CaseError extends Error {
  override readonly name = 'CaseError';
  readonly code: CaseErrorCode;

  constructor(code: CaseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
