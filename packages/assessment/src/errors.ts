export type AssessmentErrorCode =
  | 'INVALID_MARKS'
  | 'INVALID_ATTENDANCE'
  | 'UNKNOWN_COMPONENT'
  | 'MISSING_COMPONENT'
  | 'MARKS_ABOVE_MAXIMUM'
  | 'ABSENCE_NOT_ALLOWED'
  | 'INELIGIBLE_HAS_SEE_MARKS'
  | 'POLICY_UNCONFIRMED'
  | 'POLICY_INVALID'
  | 'UNKNOWN_POLICY'
  | 'PVP_SEE_ONLY'
  | 'PVP_LAB_EXCLUDED'
  | 'PVP_THEORY_EXCLUDED'
  | 'PVP_NOT_APPLICABLE'
  | 'UNKNOWN_GRADE'
  | 'INVALID_CREDITS'
  | 'INVALID_TERMS'
  | 'UNKNOWN_TERM'
  | 'DUPLICATE_ATTEMPT'
  | 'DUPLICATE_PASS';

/** A rejected input or policy. `code` is stable and safe to map to an API error. */
export class AssessmentError extends Error {
  override readonly name = 'AssessmentError';
  readonly code: AssessmentErrorCode;

  constructor(code: AssessmentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
