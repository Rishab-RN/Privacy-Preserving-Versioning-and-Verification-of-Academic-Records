import { AssessmentError } from './errors.js';
import type { AssessmentErrorCode } from './errors.js';

/** Exact non-negative rational number. Always stored in lowest terms with a positive denominator. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

const DECIMAL = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,2}))?$/;

/**
 * Parses a mark or percentage written as a plain decimal string with at most two fractional
 * digits (for example `17.5`), returning integer hundredths. Exponents, signs, whitespace and
 * leading zeros are rejected so equal values have one accepted spelling per precision.
 */
export function parseHundredths(
  text: string,
  what: string,
  code: AssessmentErrorCode = 'INVALID_MARKS',
): bigint {
  const match = typeof text === 'string' ? DECIMAL.exec(text) : null;
  if (!match) {
    throw new AssessmentError(
      code,
      `${what} must be a non-negative decimal string with at most two fractional digits`,
    );
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  return whole * 100n + fraction;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den <= 0n || num < 0n) throw new RangeError('Ratio requires num >= 0 and den > 0');
  const divisor = gcd(num, den) || 1n;
  return { num: num / divisor, den: den / divisor };
}

export const ZERO: Ratio = { num: 0n, den: 1n };

export const fromHundredths = (hundredths: bigint): Ratio => ratio(hundredths, 100n);

export const add = (a: Ratio, b: Ratio): Ratio =>
  ratio(a.num * b.den + b.num * a.den, a.den * b.den);

export function compare(a: Ratio, b: Ratio): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `part / maximum * 100`, exactly. */
export function percentOf(part: Ratio, maximum: Ratio): Ratio {
  if (maximum.num === 0n) throw new RangeError('Maximum must be positive');
  return ratio(part.num * maximum.den * 100n, part.den * maximum.num);
}

/** Rounds half-up to a whole number. Used only for rounding-sensitivity analysis. */
export function roundHalfUpWhole(value: Ratio): Ratio {
  const quotient = value.num / value.den;
  const remainder = value.num % value.den;
  return ratio(2n * remainder >= value.den ? quotient + 1n : quotient, 1n);
}

/** Rounds half-up to two decimals. Used for display and rounding-sensitivity analysis. */
export function roundHalfUpHundredths(value: Ratio): Ratio {
  const scaled = value.num * 100n;
  const hundredths = scaled / value.den + (2n * (scaled % value.den) >= value.den ? 1n : 0n);
  return ratio(hundredths, 100n);
}

/** Display string with two decimals, rounded half-up. Decisions never use this value. */
export function display(value: Ratio): string {
  const rounded = roundHalfUpHundredths(value);
  const hundredths = (rounded.num * 100n) / rounded.den;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

/** Exact text such as `539/6`, or `120` for an integer. */
export function exactText(value: Ratio): string {
  return value.den === 1n ? `${value.num}` : `${value.num}/${value.den}`;
}
