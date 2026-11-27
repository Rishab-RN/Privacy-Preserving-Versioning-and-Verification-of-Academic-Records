import type { AssessmentPolicy, Kind, Part, StudentAssessment } from '../src/index.js';

export interface PartTotals {
  readonly cieTheory: string;
  readonly cieLab: string;
  readonly seeTheory?: string;
  readonly seeLab?: string;
}

const hundredths = (text: string) => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const format = (value: bigint) =>
  value % 100n === 0n
    ? `${value / 100n}`
    : `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;

function fill(
  policy: AssessmentPolicy,
  part: Part,
  kind: Kind,
  target: string,
  marks: Record<string, string>,
) {
  let remaining = hundredths(target);
  for (const group of policy.groups.filter((g) => g.part === part && g.kind === kind)) {
    const weight = hundredths(group.weight);
    const required = group.components.filter((component) => !component.optional);
    const rawMaximum = required.reduce((sum, component) => sum + hundredths(component.maximum), 0n);
    const portion = remaining < weight ? remaining : weight;
    remaining -= portion;
    if ((portion * rawMaximum) % weight !== 0n) throw new Error(`${target} is not representable`);
    let raw = (portion * rawMaximum) / weight;
    for (const component of required) {
      const maximum = hundredths(component.maximum);
      const take = raw < maximum ? raw : maximum;
      marks[component.code] = format(take);
      raw -= take;
    }
  }
  if (remaining !== 0n) throw new Error(`${target} exceeds the ${part} ${kind} maximum`);
}

/** Distributes part totals across a policy's components, filling groups in order. */
export function marksFor(policy: AssessmentPolicy, totals: PartTotals): Record<string, string> {
  const marks: Record<string, string> = {};
  fill(policy, 'cie', 'theory', totals.cieTheory, marks);
  fill(policy, 'cie', 'lab', totals.cieLab, marks);
  if (totals.seeTheory !== undefined) fill(policy, 'see', 'theory', totals.seeTheory, marks);
  if (totals.seeLab !== undefined) fill(policy, 'see', 'lab', totals.seeLab, marks);
  return marks;
}

export const ATTENDING = { eligible: true, percent: '91.5' } as const;

export function student(
  policy: AssessmentPolicy,
  totals: PartTotals,
  attendance: StudentAssessment['attendance'] = ATTENDING,
): StudentAssessment {
  return { attendance, marks: marksFor(policy, totals) };
}
