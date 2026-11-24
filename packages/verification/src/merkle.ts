import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_TREE_LEAVES = 100_000;
export const MAX_PROOF_NODES = 64;
export const EMPTY_ROOT = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export function digest(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export function decodeHash(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Expected a lowercase SHA-256 digest');
  }
  return Buffer.from(value, 'hex');
}

export function validSize(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected a nonnegative safe integer');
  }
}

function node(left: Buffer, right: Buffer): Buffer {
  return digest(Buffer.concat([Buffer.from([1]), left, right]));
}

function leaf(commitment: unknown): Buffer {
  return digest(Buffer.concat([Buffer.from([0]), decodeHash(commitment)]));
}

function same(left: Buffer, right: Buffer): boolean {
  return timingSafeEqual(left, right);
}

function pathNodes(path: unknown): Buffer[] {
  return dataArray(path, MAX_PROOF_NODES, decodeHash);
}

function dataArray(value: unknown, limit: number, convert: (item: unknown) => Buffer): Buffer[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error('Invalid bounded array');
  }
  if (Reflect.ownKeys(value).length !== value.length + 1)
    throw new Error('Invalid array properties');
  const result: Buffer[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('Array entries must be ordinary data properties');
    }
    result.push(convert(descriptor.value));
  }
  return result;
}

function split(size: number): number {
  let power = 1;
  while (power * 2 < size) power *= 2;
  return power;
}

function tree(commitments: readonly string[]) {
  const leaves = dataArray(commitments, MAX_TREE_LEAVES, leaf);
  function root(start: number, size: number): Buffer {
    if (size === 0) return decodeHash(EMPTY_ROOT);
    if (size === 1) return leaves[start]!;
    const k = split(size);
    return node(root(start, k), root(start + k, size - k));
  }
  return { root, size: leaves.length };
}

/** Inputs are 32-byte event commitments, not precomputed Merkle leaf hashes. */
export function merkleRoot(commitments: readonly string[]): string {
  const current = tree(commitments);
  return current.root(0, current.size).toString('hex');
}

export function inclusionProof(commitments: readonly string[], index: number): string[] {
  validSize(index);
  const current = tree(commitments);
  if (index >= current.size) throw new Error('Leaf is outside the tree');
  function path(position: number, start: number, size: number): Buffer[] {
    if (size === 1) return [];
    const k = split(size);
    return position < k
      ? [...path(position, start, k), current.root(start + k, size - k)]
      : [...path(position - k, start + k, size - k), current.root(start, k)];
  }
  return path(index, 0, current.size).map((hash) => hash.toString('hex'));
}

export function verifyInclusion(
  commitment: string,
  index: number,
  size: number,
  path: readonly string[],
  root: string,
): boolean {
  try {
    validSize(index);
    validSize(size);
    if (index >= size) return false;
    let fn = BigInt(index);
    let sn = BigInt(size) - 1n;
    let hash = leaf(commitment);
    const expected = decodeHash(root);
    for (const sibling of pathNodes(path)) {
      if (sn === 0n) return false;
      if ((fn & 1n) !== 0n || fn === sn) {
        hash = node(sibling, hash);
        while (fn !== 0n && (fn & 1n) === 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      } else {
        hash = node(hash, sibling);
      }
      fn >>= 1n;
      sn >>= 1n;
    }
    return sn === 0n && same(hash, expected);
  } catch {
    return false;
  }
}

export function consistencyProof(commitments: readonly string[], oldSize: number): string[] {
  validSize(oldSize);
  const current = tree(commitments);
  if (oldSize > current.size) throw new Error('Old tree is larger than current tree');
  if (oldSize === 0 || oldSize === current.size) return [];
  function subproof(first: number, start: number, size: number, complete: boolean): Buffer[] {
    if (first === size) return complete ? [] : [current.root(start, size)];
    const k = split(size);
    return first <= k
      ? [...subproof(first, start, k, complete), current.root(start + k, size - k)]
      : [...subproof(first - k, start + k, size - k, false), current.root(start, k)];
  }
  return subproof(oldSize, 0, current.size, true).map((hash) => hash.toString('hex'));
}

export function verifyConsistency(
  oldSize: number,
  newSize: number,
  oldRoot: string,
  newRoot: string,
  path: readonly string[],
): boolean {
  try {
    validSize(oldSize);
    validSize(newSize);
    const first = decodeHash(oldRoot);
    const second = decodeHash(newRoot);
    const nodes = pathNodes(path);
    if (oldSize > newSize) return false;
    if (oldSize === 0) {
      return (
        nodes.length === 0 && oldRoot === EMPTY_ROOT && (newSize !== 0 || newRoot === EMPTY_ROOT)
      );
    }
    if (oldSize === newSize) return nodes.length === 0 && same(first, second);
    if (nodes.length === 0) return false;
    let fn = BigInt(oldSize) - 1n;
    let sn = BigInt(newSize) - 1n;
    while ((fn & 1n) !== 0n) {
      fn >>= 1n;
      sn >>= 1n;
    }
    const powerOfTwo = (BigInt(oldSize) & (BigInt(oldSize) - 1n)) === 0n;
    let fr = powerOfTwo ? first : nodes.shift()!;
    let sr = fr;
    for (const hash of nodes) {
      if (sn === 0n) return false;
      if ((fn & 1n) !== 0n || fn === sn) {
        fr = node(hash, fr);
        sr = node(hash, sr);
        while (fn !== 0n && (fn & 1n) === 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      } else {
        sr = node(sr, hash);
      }
      fn >>= 1n;
      sn >>= 1n;
    }
    return sn === 0n && same(fr, first) && same(sr, second);
  } catch {
    return false;
  }
}
