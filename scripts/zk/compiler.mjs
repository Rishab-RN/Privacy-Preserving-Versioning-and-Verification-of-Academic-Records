/* global fetch */
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
const releases = {
  win32: {
    file: 'circom-windows-amd64.exe',
    sha: 'e43f132ee6f0aa79b705beceb59c2a7e6a54d7bdeab917ca34e9fc1951d185e1',
  },
  linux: {
    file: 'circom-linux-amd64',
    sha: '85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3',
  },
};
export async function compiler() {
  const release = releases[process.platform];
  if (!release || process.arch !== 'x64')
    throw new Error('Pinned Circom compiler supports Windows/Linux x64');
  const path = resolve(
    '.runtime/tools/circom-2.2.3' + (process.platform === 'win32' ? '.exe' : ''),
  );
  if (!existsSync(path)) {
    console.log('Downloading hash-pinned official iden3 Circom 2.2.3 compiler');
    const response = await fetch(
      'https://github.com/iden3/circom/releases/download/v2.2.3/' + release.file,
    );
    if (!response.ok) throw new Error('Official compiler download failed');
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== release.sha)
      throw new Error('Compiler download hash mismatch');
    mkdirSync(resolve('.runtime/tools'), { recursive: true });
    writeFileSync(path, data, { flag: 'wx' });
  }
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== release.sha)
    throw new Error('Installed compiler hash mismatch');
  if (process.platform !== 'win32') chmodSync(path, 0o755);
  return path;
}
