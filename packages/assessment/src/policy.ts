import { compare, fromHundredths, parseHundredths } from './decimal.js';
import { AssessmentError } from './errors.js';

export type Part = 'cie' | 'see';
export type Kind = 'theory' | 'lab';
export const PARTS: readonly Part[] = ['cie', 'see'];
export const KINDS: readonly Kind[] = ['theory', 'lab'];

/** Source key `PROP` marks a prototype assumption that still needs institutional confirmation. */
export const PROPOSAL_SOURCE = 'PROP';

export interface SourceDocument {
  readonly title: string;
  readonly url: string;
}

export interface Citation {
  readonly source: string;
  readonly locator: string;
}

export interface ComponentSpec {
  readonly code: string;
  readonly label: string;
  readonly maximum: string;
  readonly optional?: true;
}

/**
 * `sum-required`: add every required component. `unconfirmed`: the source names an optional
 * component without a published selection rule; supplying it is refused until confirmed.
 */
export type Selection =
  { readonly rule: 'sum-required' } | { readonly rule: 'unconfirmed'; readonly question: string };

export interface GroupSpec {
  readonly code: string;
  readonly label: string;
  readonly part: Part;
  readonly kind: Kind;
  readonly components: readonly ComponentSpec[];
  /** Marks the group contributes after reduction, e.g. two 50-mark tests reduced to 40. */
  readonly weight: string;
  readonly selection: Selection;
  readonly citation: Citation;
}

export interface GradeBand {
  readonly letter: string;
  readonly minimumPercent: string;
  readonly points: number;
}

export interface AssessmentPolicy {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly scheme: string;
  readonly courseType: 'integrated-theory-lab';
  readonly status: 'pending-institutional-confirmation' | 'confirmed';
  readonly sources: Readonly<Record<string, SourceDocument>>;
  readonly groups: readonly GroupSpec[];
  readonly minimumPercent: {
    readonly cie: Readonly<Record<Kind, string>>;
    readonly see: Readonly<Record<Kind, string>>;
    /** Theory and lab together, over the course total. */
    readonly aggregate: string;
    readonly citations: readonly Citation[];
  };
  readonly grades: {
    readonly bands: readonly GradeBand[];
    readonly citations: readonly Citation[];
  };
  readonly eligibility: {
    readonly ineligibleLetter: string;
    readonly citations: readonly Citation[];
  };
  readonly transitionalX: {
    readonly minimumAttendancePercent: string;
    readonly minimumCiePercent: string;
    readonly citations: readonly Citation[];
  };
  readonly paperViewing: {
    readonly parts: readonly Part[];
    readonly kinds: readonly Kind[];
    readonly rule: 'better-of';
    readonly citations: readonly Citation[];
  };
  /** Only exact evaluation is implemented; official rounding is unconfirmed (plan Q6). */
  readonly rounding: { readonly mode: 'exact'; readonly confirmed: false };
  /** Parts whose components may be recorded as `AB` (absent). */
  readonly absence: { readonly parts: readonly Part[]; readonly citations: readonly Citation[] };
}

function invalid(policy: string, message: string): never {
  throw new AssessmentError('POLICY_INVALID', `${policy}: ${message}`);
}

function percent(policy: string, text: string, what: string) {
  const value = fromHundredths(parseHundredths(text, `${policy} ${what}`, 'POLICY_INVALID'));
  if (compare(value, fromHundredths(10_000n)) > 0) invalid(policy, `${what} exceeds 100`);
  return value;
}

/**
 * Checks the structural and semantic rules every policy must satisfy before it is used. Returns
 * the same object so callers can register it in one expression.
 */
export function assertPolicy(policy: AssessmentPolicy): AssessmentPolicy {
  const id = policy.id;
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/.test(id)) invalid(id, 'id must be a lowercase slug');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) invalid(id, 'bad version');
  if (!policy.title.trim()) invalid(id, 'title is required');

  const citations: Citation[] = [
    ...policy.groups.map((group) => group.citation),
    ...policy.minimumPercent.citations,
    ...policy.grades.citations,
    ...policy.eligibility.citations,
    ...policy.transitionalX.citations,
    ...policy.paperViewing.citations,
    ...policy.absence.citations,
  ];
  for (const citation of citations) {
    if (citation.source !== PROPOSAL_SOURCE && !policy.sources[citation.source]) {
      invalid(id, `citation references unknown source ${citation.source}`);
    }
    if (!citation.locator.trim()) invalid(id, 'citation locator is required');
  }

  const groupCodes = new Set<string>();
  const componentCodes = new Set<string>();
  for (const group of policy.groups) {
    if (groupCodes.has(group.code)) invalid(id, `duplicate group ${group.code}`);
    groupCodes.add(group.code);
    if (!PARTS.includes(group.part) || !KINDS.includes(group.kind)) {
      invalid(id, `group ${group.code} has an unknown part or kind`);
    }
    if (parseHundredths(group.weight, `${id} ${group.code} weight`, 'POLICY_INVALID') <= 0n) {
      invalid(id, `group ${group.code} weight must be positive`);
    }
    let required = 0;
    for (const component of group.components) {
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(component.code)) {
        invalid(id, `component code ${component.code} is not a snake_case identifier`);
      }
      if (componentCodes.has(component.code)) invalid(id, `duplicate component ${component.code}`);
      componentCodes.add(component.code);
      const max = parseHundredths(component.maximum, `${id} ${component.code}`, 'POLICY_INVALID');
      if (max <= 0n) invalid(id, `component ${component.code} maximum must be positive`);
      if (component.optional) {
        if (group.selection.rule === 'sum-required') {
          invalid(id, `optional component ${component.code} needs a selection rule`);
        }
      } else required += 1;
    }
    if (required === 0) invalid(id, `group ${group.code} has no required component`);
  }
  for (const part of PARTS) {
    for (const kind of KINDS) {
      if (!policy.groups.some((group) => group.part === part && group.kind === kind)) {
        invalid(id, `no ${part} ${kind} group`);
      }
    }
  }

  for (const kind of KINDS) {
    percent(id, policy.minimumPercent.cie[kind], `minimum CIE ${kind}`);
    percent(id, policy.minimumPercent.see[kind], `minimum SEE ${kind}`);
  }
  const aggregate = percent(id, policy.minimumPercent.aggregate, 'minimum aggregate');
  percent(id, policy.transitionalX.minimumAttendancePercent, 'X attendance');
  percent(id, policy.transitionalX.minimumCiePercent, 'X CIE');

  const bands = policy.grades.bands;
  if (bands.length < 2) invalid(id, 'at least a pass and a fail band are required');
  const letters = new Set<string>([policy.eligibility.ineligibleLetter, 'X']);
  let previous: ReturnType<typeof percent> | null = null;
  let previousPoints = Number.POSITIVE_INFINITY;
  for (const band of bands) {
    if (!band.letter.trim() || letters.has(band.letter)) {
      invalid(id, `band letter ${band.letter} is empty or reused`);
    }
    letters.add(band.letter);
    const minimum = percent(id, band.minimumPercent, `band ${band.letter}`);
    if (previous && compare(minimum, previous) >= 0) invalid(id, 'bands must strictly descend');
    if (!Number.isInteger(band.points) || band.points < 0 || band.points > 10) {
      invalid(id, `band ${band.letter} points must be an integer from 0 to 10`);
    }
    if (band.points > previousPoints) invalid(id, 'band points must not increase');
    previous = minimum;
    previousPoints = band.points;
  }
  const last = bands[bands.length - 1];
  if (!last || last.points !== 0 || last.minimumPercent !== '0') {
    invalid(id, 'the last band must be the zero-point fail band starting at 0');
  }
  const lowestPass = bands[bands.length - 2];
  if (!lowestPass || compare(percent(id, lowestPass.minimumPercent, 'pass band'), aggregate)) {
    invalid(id, 'the aggregate minimum must equal the lowest passing band minimum');
  }

  for (const part of policy.paperViewing.parts) {
    if (!PARTS.includes(part)) invalid(id, `paper viewing part ${part} is unknown`);
  }
  for (const kind of policy.paperViewing.kinds) {
    if (!KINDS.includes(kind)) invalid(id, `paper viewing kind ${kind} is unknown`);
  }
  for (const part of policy.absence.parts) {
    if (!PARTS.includes(part)) invalid(id, `absence part ${part} is unknown`);
  }
  return policy;
}
