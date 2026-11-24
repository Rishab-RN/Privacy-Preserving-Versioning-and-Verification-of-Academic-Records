export const MAX_JSON_BYTES = 1_048_576;
export const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** RFC 8785 serialization for a bounded JSON-only domain; no toJSON hooks. */
export function canonicalBytes(value: unknown): Buffer {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  const string = (text: string): string => {
    if (!text.isWellFormed()) throw new Error('Invalid Unicode scalar data');
    stringBytes += Buffer.byteLength(text, 'utf8');
    if (stringBytes > MAX_JSON_BYTES) throw new Error('JSON exceeds byte limit');
    return JSON.stringify(text);
  };
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error('JSON exceeds structural limits');
    }
    if (input === null) return 'null';
    switch (typeof input) {
      case 'string':
        return string(input);
      case 'boolean':
        return input ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(input)) throw new Error('JSON number must be finite');
        return JSON.stringify(input);
      case 'object':
        break;
      default:
        throw new Error('Only JSON values are permitted');
    }
    if (ancestors.has(input)) throw new Error('JSON cannot contain cycles');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_JSON_NODES) {
          throw new Error('Invalid JSON array');
        }
        const own = Reflect.ownKeys(input);
        if (own.length !== input.length + 1) throw new Error('Sparse or decorated array');
        const items: string[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            throw new Error('Array entries must be ordinary data properties');
          }
          items.push(visit(descriptor.value, depth + 1));
        }
        return '[' + items.join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('JSON objects must have ordinary or null prototypes');
      }
      const keys = Reflect.ownKeys(input);
      if (keys.some((key) => typeof key !== 'string'))
        throw new Error('JSON cannot have symbol keys');
      const members: string[] = [];
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new Error('Object members must be enumerable data properties');
        }
        members.push(string(key) + ':' + visit(descriptor.value, depth + 1));
      }
      return '{' + members.join(',') + '}';
    } finally {
      ancestors.delete(input);
    }
  };
  const bytes = Buffer.from(visit(value, 0), 'utf8');
  if (bytes.length > MAX_JSON_BYTES) throw new Error('JSON exceeds byte limit');
  return bytes;
}

/** The wire profile requires canonical UTF-8, rejecting duplicates and BOMs. */
export function parseCanonical(bytes: Uint8Array): JsonValue {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error('Invalid canonical JSON byte input');
  }
  const source = Buffer.from(bytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  const value: unknown = JSON.parse(text);
  const canonical = canonicalBytes(value);
  if (!source.equals(canonical)) throw new Error('Input is not canonical JSON');
  return value as JsonValue;
}
