import { parseHundredths } from './decimal.js';
import { AssessmentError } from './errors.js';
import type { AssessmentPolicy } from './policy.js';
import { ABSENT } from './result.js';

export interface PaperViewingResolution {
  /** The original marks with each revised component replaced by the better of the two values. */
  readonly marks: Readonly<Record<string, string>>;
  readonly increased: readonly string[];
  /** Lower revaluations are ignored: no negative evaluation (S2 §4.7, S3 §4.8). */
  readonly ignoredDecreases: readonly string[];
  readonly changed: boolean;
}

/**
 * Applies an expert team's revaluation after the Paper Viewing Process. Only components in the
 * policy's eligible parts and kinds (SEE theory for RVCE) may be revised, and the better of the
 * original and revised marks is kept. Recompute the result with `calculateResult` afterwards.
 */
export function resolvePaperViewing(
  policy: AssessmentPolicy,
  original: Readonly<Record<string, string>>,
  revised: Readonly<Record<string, string>>,
): PaperViewingResolution {
  const marks: Record<string, string> = { ...original };
  const increased: string[] = [];
  const ignoredDecreases: string[] = [];
  const rule = policy.paperViewing;

  for (const code of Object.keys(revised).sort()) {
    const group = policy.groups.find((candidate) =>
      candidate.components.some((component) => component.code === code),
    );
    const component = group?.components.find((candidate) => candidate.code === code);
    if (!group || !component) {
      throw new AssessmentError('UNKNOWN_COMPONENT', `${code} is not part of ${policy.id}`);
    }
    if (!rule.parts.includes(group.part)) {
      throw new AssessmentError('PVP_SEE_ONLY', `${code} is not eligible for paper viewing`);
    }
    if (!rule.kinds.includes(group.kind)) {
      throw new AssessmentError(
        group.kind === 'lab' ? 'PVP_LAB_EXCLUDED' : 'PVP_THEORY_EXCLUDED',
        `${group.kind} examinations are excluded from paper viewing`,
      );
    }
    const before = original[code];
    if (before === undefined || before === ABSENT) {
      throw new AssessmentError('PVP_NOT_APPLICABLE', `${code} has no evaluated script to revisit`);
    }
    const proposed = revised[code] ?? '';
    const after = parseHundredths(proposed, code);
    if (after > parseHundredths(component.maximum, code)) {
      throw new AssessmentError('MARKS_ABOVE_MAXIMUM', `${code} exceeds ${component.maximum}`);
    }
    const current = parseHundredths(before, code);
    if (after > current) {
      marks[code] = proposed;
      increased.push(code);
    } else if (after < current) {
      ignoredDecreases.push(code);
    }
  }
  return { marks, increased, ignoredDecreases, changed: increased.length > 0 };
}
