import { writeFile } from 'node:fs/promises';
import { MATRIX_PATH, formattedMatrix } from './matrix-file.js';

await writeFile(MATRIX_PATH, await formattedMatrix(), 'utf8');
console.log(`Wrote ${MATRIX_PATH}`);
