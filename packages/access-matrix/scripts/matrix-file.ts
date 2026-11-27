import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { PILOT_WORLD, renderMatrix } from '../src/index.js';

export const MATRIX_PATH = fileURLToPath(new URL('../MATRIX.md', import.meta.url));

/** The rendered matrix, formatted with the repository's Prettier settings. */
export async function formattedMatrix(): Promise<string> {
  const options = (await resolveConfig(MATRIX_PATH)) ?? {};
  return format(renderMatrix(PILOT_WORLD), { ...options, filepath: MATRIX_PATH });
}
