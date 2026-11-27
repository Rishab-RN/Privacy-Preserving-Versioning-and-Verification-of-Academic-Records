/** Actions in the marks-to-results pilot, with the resource each one targets. */
export const ACTIONS = {
  'roster.read': { resource: 'offering', mode: 'read', summary: 'Open an offering roster' },
  'batch.create': {
    resource: 'offering-stage',
    mode: 'write',
    summary: 'Create a CIE or SEE marks batch for an offering',
  },
  'batch.submit': { resource: 'batch', mode: 'write', summary: 'Submit an authored marks batch' },
  'batch.revise': {
    resource: 'batch',
    mode: 'write',
    summary: 'Create a revised marks revision (edit marks)',
  },
  'batch.validate': {
    resource: 'batch',
    mode: 'write',
    summary: 'Record an import and roster validation report',
  },
  'batch.review': { resource: 'batch', mode: 'write', summary: 'Approve or return a CIE batch' },
  'results.publish': {
    resource: 'offering',
    mode: 'write',
    summary: 'Publish provisional or final results',
  },
  'result.read': { resource: 'result', mode: 'read', summary: 'Read a student course result' },
  'cie.acknowledge': {
    resource: 'result',
    mode: 'write',
    summary: 'Acknowledge displayed CIE marks',
  },
  'correction.propose': {
    resource: 'result',
    mode: 'write',
    summary: 'Propose a correction to a published result',
  },
  'correction.approve': {
    resource: 'correction',
    mode: 'write',
    summary: 'Approve a proposed correction',
  },
  'dashboard.read': {
    resource: 'dashboard',
    mode: 'read',
    summary: 'Read an aggregate completion dashboard',
  },
  'integrity.review': {
    resource: 'institution',
    mode: 'read',
    summary: 'Review signed history, provenance and risk signals',
  },
  'delegation.grant': {
    resource: 'institution',
    mode: 'write',
    summary: 'Grant a time-bound task to exam-section staff',
  },
  'proof.issue': {
    resource: 'result',
    mode: 'write',
    summary: 'Issue a private grade-threshold credential',
  },
  'proof.verify': { resource: 'public', mode: 'read', summary: 'Verify a consented proof' },
} as const satisfies Record<string, ActionSpec>;

export interface ActionSpec {
  readonly resource: ResourceType;
  readonly mode: 'read' | 'write';
  readonly summary: string;
}

export type Action = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];

export type ResourceType =
  | 'offering'
  | 'offering-stage'
  | 'batch'
  | 'result'
  | 'correction'
  | 'dashboard'
  | 'institution'
  | 'public';

export type Stage = 'cie' | 'see';
export const STAGES: readonly Stage[] = ['cie', 'see'];

/** Institution-level memberships. A membership alone grants nothing unless a grant names it. */
export type Role =
  | 'student'
  | 'faculty'
  | 'examiner'
  | 'registrar'
  | 'auditor'
  | 'exam_staff'
  | 'exam_approver'
  | 'dean_academics';

export type OfferingDuty = 'course_teacher' | 'see_examiner';
export type DepartmentDuty = 'hod' | 'hod_delegate';
export type DelegableTask = 'validate_import' | 'reconcile_roster' | 'track_request';

export interface Delegation {
  readonly grantor: string;
  readonly tasks: readonly DelegableTask[];
  readonly departments: readonly string[];
  readonly term: string;
  /** Half-open validity interval `[validFrom, validUntil)` as ISO 8601 instants. */
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface Principal {
  readonly persona: string;
  readonly roles: readonly Role[];
  readonly student?: string;
  readonly offeringDuties?: readonly { readonly offering: string; readonly duty: OfferingDuty }[];
  readonly departmentDuties?: readonly {
    readonly department: string;
    readonly term: string;
    readonly duty: DepartmentDuty;
  }[];
  readonly delegations?: readonly Delegation[];
}

export interface Offering {
  readonly course: string;
  readonly department: string;
  readonly term: string;
  readonly published: boolean;
}

/** Workflow history used for separation of duties. Authority to create it is checked separately. */
export interface Batch {
  readonly offering: string;
  readonly stage: Stage;
  readonly author: string;
  readonly validators: readonly string[];
  readonly reviewer: string | null;
}

export interface Result {
  readonly student: string;
  readonly offering: string;
}

export interface Correction {
  readonly result: string;
  readonly proposer: string;
}

export interface Dashboard {
  readonly department: string | null;
  readonly term: string;
}

export interface World {
  readonly name: string;
  /** Evaluation instant for delegation validity. */
  readonly now: string;
  readonly principals: Readonly<Record<string, Principal>>;
  readonly offerings: Readonly<Record<string, Offering>>;
  readonly batches: Readonly<Record<string, Batch>>;
  readonly results: Readonly<Record<string, Result>>;
  readonly corrections: Readonly<Record<string, Correction>>;
  readonly dashboards: Readonly<Record<string, Dashboard>>;
}

export type Via =
  | { readonly kind: 'role'; readonly role: Role }
  | { readonly kind: 'offering'; readonly duty: OfferingDuty; readonly stage?: Stage }
  | { readonly kind: 'department'; readonly duty: DepartmentDuty; readonly stage?: Stage }
  | { readonly kind: 'delegation'; readonly task: DelegableTask };

/**
 * `own`: the principal's own student record. `own-published`: own and the offering is published.
 * `assigned`: an offering duty on the resource's offering. `authored`: assigned and the principal
 * authored the batch. `department`: a department duty for the resource's department and term.
 * `delegated`: an active delegation for the department and term. `institution`: anywhere in the
 * single pilot institution.
 */
export type Scope =
  'own' | 'own-published' | 'assigned' | 'authored' | 'department' | 'delegated' | 'institution';

/** `S2`/`S4`: RVCE sources (pilot plan). `REPO`: existing repository policy. `PROP`: proposal. */
export interface Basis {
  readonly source: 'S2' | 'S4' | 'REPO' | 'PROP';
  readonly locator: string;
}

export interface Grant {
  readonly action: Action;
  readonly via: Via;
  readonly scope: Scope;
  readonly basis: Basis;
}

export type SeparationCode = 'SELF_REVIEW' | 'SELF_APPROVAL' | 'SOD_CONFLICT';

export type SeparationRule =
  | 'batch-author'
  | 'batch-validator'
  | 'batch-reviewer'
  | 'offering-participant'
  | 'correction-proposer'
  | 'record-author';

export interface Separation {
  readonly action: Action;
  readonly when: SeparationRule;
  readonly code: SeparationCode;
  readonly basis: Basis;
}

export type Outcome =
  | { readonly status: 200; readonly code: 'ALLOWED' }
  | { readonly status: 401; readonly code: 'UNAUTHENTICATED' }
  | { readonly status: 403; readonly code: 'FORBIDDEN' | SeparationCode }
  | { readonly status: 404; readonly code: 'NOT_FOUND' };
