export interface LivenessResponse {
  status: 'ok';
  service: 'scholarproof-api';
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface SessionResponse {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
}

export interface EvidenceReceipt {
  evidenceId: string;
  state: 'available';
  digestSha256: string;
  sizeBytes: number;
}

export interface UserPrincipal {
  userId: string;
  subject: string;
  students: { studentId: string; institutionId: string }[];
  roles: { institutionId: string; role: 'registrar' | 'examiner' | 'student' | 'auditor' }[];
}
export interface StudentSummary {
  studentId: string;
  studentCode: string;
  institutionId: string;
}
export interface TranscriptRecord {
  record_id: string;
  version_no: number;
  course_code: string;
  credits: string;
  grade_points: string | null;
  outcome: GradeOutcome;
  recorded_at: string;
  valid_during: string;
}
export interface TranscriptResponse {
  studentId: string;
  knownAt: string;
  effectiveAt: string;
  records: TranscriptRecord[];
}

export type GradeOutcome = 'passed' | 'failed' | 'withdrawn' | 'incomplete';
export interface ChangeProposalInput {
  expectedVersion: number;
  gradePoints: string | null;
  outcome: GradeOutcome;
  validFrom: string;
  validUntil: string | null;
  evidenceId: string;
  reason: string;
}
export interface ChangeRequestStatus extends ChangeProposalInput {
  requestId: string;
  recordId: string;
  submittedBy: string;
  submittedAt: string;
  currentVersion: number;
  stale: boolean;
  decision: null | {
    code: 'approved' | 'rejected';
    actorId: string;
    reason: string;
    versionNo: number | null;
    decidedAt: string;
  };
  deliveries: {
    eventId: string;
    kind: 'request.submitted' | 'request.rejected' | 'grade.accepted';
    state: 'pending' | 'leased' | 'delivered' | 'quarantined';
    attempts: number;
    nextAttemptAt: string;
    lastErrorCode: string | null;
  }[];
}
