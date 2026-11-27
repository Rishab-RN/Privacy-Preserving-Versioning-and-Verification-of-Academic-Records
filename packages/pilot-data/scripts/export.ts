import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_OPTIONS, generatePilotData, summarizePilotData } from '../src/index.js';

/**
 * Writes the dataset to the ignored `.runtime/pilot-data/` folder, e.g.
 * `npm run export --workspace @academic-records/pilot-data -- --ai-a 240`.
 */
const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    'ai-a': { type: 'string' },
    'ai-b': { type: 'string' },
    'is-a': { type: 'string' },
  },
});
const number = (text: string | undefined, fallback: number) =>
  text === undefined ? fallback : Number.parseInt(text, 10);
const options = {
  seed: number(values.seed, DEFAULT_OPTIONS.seed),
  sections: {
    'ai-a': number(values['ai-a'], DEFAULT_OPTIONS.sections['ai-a']),
    'ai-b': number(values['ai-b'], DEFAULT_OPTIONS.sections['ai-b']),
    'is-a': number(values['is-a'], DEFAULT_OPTIONS.sections['is-a']),
  },
};

const data = generatePilotData(options);
const folder = fileURLToPath(new URL('../../../.runtime/pilot-data/', import.meta.url));
const file = `${folder}pilot-data-${options.seed}-${options.sections['ai-a']}.json`;
await mkdir(folder, { recursive: true });
await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ file, ...summarizePilotData(data) }, null, 2));
