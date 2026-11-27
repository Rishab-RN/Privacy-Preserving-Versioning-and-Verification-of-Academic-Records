import { CaseError } from './errors.js';
import type { CaseErrorCode } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

/** Parses a calendar date `YYYY-MM-DD` to a UTC day number. Rejects impossible dates. */
export function day(text: string, what: string, code: CaseErrorCode = 'INVALID_DATE'): number {
  const match = typeof text === 'string' ? ISO_DATE.exec(text) : null;
  if (match) {
    const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const value = Date.UTC(year, month - 1, date);
    const parsed = new Date(value);
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === date
    ) {
      return value / DAY;
    }
  }
  throw new CaseError(code, `${what} must be a real date written YYYY-MM-DD`);
}

export const formatDay = (value: number): string =>
  new Date(value * DAY).toISOString().slice(0, 10);

/** Adds calendar months, clamping to the last day of a shorter month (Jan 31 + 1 → Feb 28/29). */
export function addMonths(value: number, months: number): number {
  const date = new Date(value * DAY);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target.getTime() / DAY;
}
