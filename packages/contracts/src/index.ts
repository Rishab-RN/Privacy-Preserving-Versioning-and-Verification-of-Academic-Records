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

export type PilotBatchStage = 'cie' | 'see';

/** One marks revision in column form: `values[i]` is the entry for `components[i]`. */
export interface PilotBatchInput {
  stage: PilotBatchStage;
  /** The revision this one replaces; 0 for the first revision. */
  expectedRevision: number;
  components: string[];
  /** Decimal marks such as `"17.5"`, or `"AB"` where the policy allows absence. */
  rows: { enrolmentId: string; values: string[] }[];
}

export interface PilotBatchCreated {
  batchId: string;
  offeringId: string;
  stage: PilotBatchStage;
  revisionNo: number;
  /** False when an exact retry returned the existing revision. */
  created: boolean;
  /** SHA-256 of the canonical rows, for later signing and comparison. */
  contentDigest: string;
}

export interface PilotBatchReview {
  verdict: 'approved' | 'returned';
  reviewerSubject: string;
  reviewedAt: string;
  reason: string | null;
}

export interface PilotBatchValidation {
  validatorSubject: string;
  checkedAt: string;
  /** Enrolled students without a row in the batch when it was validated. */
  missingRows: number;
  note: string | null;
}

export interface PilotBatchSummary {
  batchId: string;
  stage: PilotBatchStage;
  revisionNo: number;
  authorSubject: string;
  createdAt: string;
  submittedAt: string | null;
  review: PilotBatchReview | null;
  validation: PilotBatchValidation | null;
}

export interface PilotReviewInput {
  verdict: 'approved' | 'returned';
  /** Required when returning a batch. */
  reason?: string;
}

export interface PilotReviewResult {
  batchId: string;
  verdict: 'approved' | 'returned';
  reviewedAt: string;
  alreadyReviewed: boolean;
}

export interface PilotValidationResult {
  batchId: string;
  checkedAt: string;
  missingRows: number;
  alreadyValidated: boolean;
}

export interface PilotQueueEntry {
  batchId: string;
  offeringId: string;
  stage: PilotBatchStage;
  revisionNo: number;
  submittedAt: string;
}

export interface PilotBatch extends PilotBatchSummary {
  offeringId: string;
  policy: { id: string; version: number };
  components: string[];
  rows: { enrolmentId: string; studentCode: string; values: string[] }[];
}

export interface PilotBatchSubmission {
  batchId: string;
  submittedAt: string;
  /** True when the batch had already been submitted. */
  alreadySubmitted: boolean;
}

/** Imported attendance for one enrolment, recorded with the publication. */
export interface PilotAttendance {
  enrolmentId: string;
  /** Eligibility after any condonation, decided by the attendance process. */
  eligible: boolean;
  /** Recorded percentage with up to two decimals; used only for the X grade. */
  percent?: string;
}

export interface PilotPublishInput {
  attendance: PilotAttendance[];
}

export interface PilotPublishResult {
  publicationId: string;
  offeringId: string;
  kind: 'provisional';
  publishedAt: string;
  records: number;
  inputs: { cie: string; see: string };
  /** True when the same publisher had already published with the same attendance. */
  alreadyPublished: boolean;
}

export interface PilotScore {
  marks: string;
  maximum: string;
  percent: string;
}

/**
 * A course result. Grade points and outcome are the stored grade version; the letter, status,
 * reasons and breakdown are recomputed from the stored inputs and the frozen policy.
 */
export interface PilotCourseResult {
  status: 'graded' | 'not-eligible' | 'see-absent' | 'transitional';
  letter: string | null;
  gradePoints: number | null;
  outcome: 'passed' | 'failed' | 'incomplete';
  reasons: string[];
  cie: { theory: PilotScore; lab: PilotScore; total: PilotScore };
  see: { theory: PilotScore; lab: PilotScore } | null;
  total: PilotScore | null;
}

export interface PilotPublishedResult extends PilotCourseResult {
  enrolmentId: string;
  studentCode: string;
  recordId: string;
  /** The current grade version; the breakdown includes approved paper-viewing revisions. */
  versionNo: number;
  publishedVersionNo: number;
  revisedAfterPvp: boolean;
  /** Components eligible for paper viewing, with current marks (`AB` when absent). */
  paperViewing: { code: string; marks: string; maximum: string }[];
  /** Whether recomputation reproduces both the published and the current stored grade. */
  matches: boolean;
}

export interface PilotPublication {
  publicationId: string;
  offeringId: string;
  kind: 'provisional' | 'final';
  publisherSubject: string;
  publishedAt: string;
  policy: { id: string; version: number };
  inputs: { batchId: string; stage: PilotBatchStage; revisionNo: number }[];
  results: PilotPublishedResult[];
  /** Recomputation of every stored grade; mismatches lists student codes. */
  audit: { records: number; mismatches: string[] };
}

export interface PilotStudentResult extends PilotCourseResult {
  offeringId: string;
  recordId: string;
  courseCode: string;
  section: string;
  term: string;
  label: 'Provisional' | 'Final';
  publishedAt: string;
  versionNo: number;
  revisedAfterPvp: boolean;
}

/** What the caller may do on one pilot offering; the API still decides every request. */
export interface PilotDeskOffering {
  offeringId: string;
  courseCode: string;
  sectionCode: string;
  termCode: string;
  departmentCode: string;
  /** Stages the caller enters marks for: course teachers enter CIE, SEE examiners SEE. */
  entryStages: PilotBatchStage[];
  reviews: boolean;
  validates: boolean;
  /** An exam approver who took no part in the offering's marks. */
  publishes: boolean;
  readsResults: boolean;
  /** A registrar who may propose paper-viewing corrections. */
  corrects: boolean;
  published: boolean;
}

export interface PilotEntryForm {
  policy: { id: string; version: number };
  stage: PilotBatchStage;
  components: { code: string; group: string; kind: 'theory' | 'lab'; maximum: string }[];
  /** Whether `AB` may record an absence in this stage. */
  absenceAllowed: boolean;
}

/** An expert team's revalued SEE theory marks after the Paper Viewing Process. */
export interface PilotPvpInput {
  expectedVersion: number;
  /** Revised marks by component code, as decimal strings. */
  revised: Record<string, string>;
  reason: string;
}

export interface PilotPvpProposal {
  request: ChangeRequestStatus;
  evidenceId: string;
  increased: string[];
  result: { letter: string | null; gradePoints: number | null; outcome: string };
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
