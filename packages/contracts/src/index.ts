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
  roles: {
    institutionId: string;
    role:
      | 'registrar'
      | 'examiner'
      | 'student'
      | 'auditor'
      | 'faculty'
      | 'exam_staff'
      | 'exam_approver'
      | 'dean_academics';
  }[];
}

export interface PilotOffering {
  offeringId: string;
  departmentCode: string;
  courseCode: string;
  sectionCode: string;
  termCode: string;
}

export interface PilotRoster {
  students: { enrolmentId: string; studentCode: string }[];
  nextAfter: string | null;
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
export interface RecordHistoryResponse {
  revisions: Pick<
    TranscriptRecord,
    'version_no' | 'grade_points' | 'outcome' | 'valid_during' | 'recorded_at'
  >[];
  nextBefore: number | null;
}
export interface EligibleProofRecord {
  recordId: string;
  versionNo: number;
  courseCode: string;
}
export interface ProvenanceReview {
  status: 'current' | 'lagging';
  through: number;
  committed: number;
  syncedAt: string | null;
  from: string;
  to: string;
  ancestry: {
    version: number;
    requestId: string | null;
    eventId: string | null;
    occurredAt: string | null;
    evidenceId: string | null;
    proposerId: string | null;
    approverId: string | null;
  }[];
  pairings: { proposerId: string; approverId: string; count: number; requestIds: string[] }[];
  upward: { courseId: string; count: number; deltaHundredths: number; requestIds: string[] }[];
  evidenceReuse: { digest: string; count: number; requestIds: string[] }[];
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

export type AnomalyFeature =
  'delta' | 'missingDelta' | 'record30d' | 'course30d' | 'proposer30d' | 'pair30d' | 'evidence30d';

export interface CorrectionIntegrity {
  event: 'verified' | 'invalid-proof' | 'journal-mismatch' | 'not-approved' | 'key-unavailable';
  witness:
    | 'unchecked'
    | 'unavailable'
    | 'matched'
    | 'extended'
    | 'older-export'
    | 'split-view'
    | 'invalid-consistency'
    | 'journal-behind-witness';
  committed: number;
  checkpointSize: number | null;
  retainedSize: number | null;
}

export interface AnomalyRank {
  requestId: string;
  recordId: string;
  version: number;
  occurredAt: string;
  score: number;
  rank: number;
  flagged: boolean;
  signals: { feature: AnomalyFeature; value: number; effect: number }[];
  rules: AnomalyFeature[];
}

export type AnomalyReview =
  | {
      status: 'unavailable';
      committed: number;
      reason: 'missing-snapshot' | 'invalid-snapshot' | 'graph-unavailable';
    }
  | {
      status: 'current' | 'stale';
      committed: number;
      through: number;
      generatedAt: string;
      modelVersion: string;
      featureSchema: 'decision-features-v1';
      trainedOn: 'synthetic';
      threshold: number;
      total: number;
      selected: AnomalyRank | null;
      queue: AnomalyRank[];
    };
