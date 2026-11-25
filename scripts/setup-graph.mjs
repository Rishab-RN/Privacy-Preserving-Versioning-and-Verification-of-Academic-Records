import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import console from 'node:console';

const file = '.env.graph';
if (!existsSync(file)) {
  writeFileSync(
    file,
    `GRAPH_NEO4J_PORT=57687\nGRAPH_NEO4J_PASSWORD=${randomBytes(24).toString('base64url')}\n`,
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  console.log('Created ignored graph configuration.');
} else console.log('Preserved existing graph configuration.');
